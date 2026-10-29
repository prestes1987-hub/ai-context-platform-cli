import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { chat, closeSession } from "./assistant.ts";
import { loadConfig, type Config } from "./config.ts";
import { footer, renderTrace } from "./debug.ts";
import { runDemo } from "./eval/demo.ts";
import { runEvaluation } from "./eval/run-eval.ts";
import { ingest } from "./knowledge/ingest.ts";
import { loadKnowledgeBase } from "./knowledge/knowledge-base.ts";
import { manualMemory } from "./memory/extractor.ts";
import { getUser, listUsers, profileFacts } from "./memory/users.ts";
import { createPlatform, reloadIndex, type Platform } from "./platform.ts";

const HELP = `Uso:
  npm run ingest [-- --rebuild]                    indexa knowledge-base/ (incremental) no SQLite
  npm run kb                                       lista documentos e seções da base
  npm run chat -- --user U-001 [--session <id>]    conversa interativa com memória (retoma sessão pelo id)
  npm run ask -- --user U-001 "mensagem"           um turno (use --session para continuar uma sessão)
  npm run eval                                     roda os testes de comportamento → docs/relatorio-avaliacao.md
  npm run demo                                     demonstração roteirizada → docs/demonstracao.md

Opções:
  --user <id>          colaborador (U-001 Ana · U-002 Bruno · U-003 Carla)
  --session <id>       retoma uma sessão existente
  --debug              mostra memória, busca, contexto (tokens por módulo) e regras aplicadas
  --no-memory          desliga perfil + memória de longo prazo (baseline)
  --threshold <0..1>   score híbrido mínimo para um trecho entrar no contexto
  --top-k <n>          máximo de trechos no contexto
  --offline            força embedder local + LLM extrativo

Comandos no chat: /ajuda /perfil /memorias [todas] /lembrar <texto> /esquecer <id> /sessoes /retomar <id>
                  /nova /contexto /debug /sair`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      user: { type: "string" },
      session: { type: "string" },
      debug: { type: "boolean" },
      "no-memory": { type: "boolean" },
      threshold: { type: "string" },
      "top-k": { type: "string" },
      offline: { type: "boolean" },
      rebuild: { type: "boolean" },
      help: { type: "boolean", short: "h" }
    }
  });
  if (values.help) return console.log(HELP);
  const config = loadConfig({
    debug: values.debug,
    offline: values.offline,
    threshold: values.threshold === undefined ? undefined : Number(values.threshold),
    topK: values["top-k"] === undefined ? undefined : Number(values["top-k"])
  });

  const [command = "chat", ...args] = positionals;
  switch (command) {
    case "ingest": return runIngest(config, values.rebuild ?? false);
    case "kb": return listKb(config);
    case "eval": return runEvaluation(config);
    case "demo": return runDemo(config);
    case "ask":
    case "chat": {
      const platform = await createPlatform(config, { features: { longTermMemory: !values["no-memory"] } });
      if (platform.ingestReport) console.error(`(base indexada automaticamente: ${platform.ingestReport.chunks} seções)`);
      return command === "ask" ? ask(platform, values.user, values.session, args.join(" ").trim()) : interactive(platform, values.user, values.session);
    }
    default: throw new Error(`Comando desconhecido: "${command}".\n\n${HELP}`);
  }
}

async function runIngest(config: Config, rebuild: boolean): Promise<void> {
  const platform = await createPlatform(config);
  if (rebuild) platform.db.exec("DELETE FROM chunks; DELETE FROM documents;");
  const report = platform.ingestReport && !rebuild ? platform.ingestReport : await ingest(platform.db, platform.embedder, config.kbDir);
  reloadIndex(platform);
  console.log(`embedder: ${platform.embedder.name}${report.rebuilt ? " (modelo mudou → índice refeito)" : ""}`);
  console.log(`novos: ${report.added.join(", ") || "-"} | atualizados: ${report.updated.join(", ") || "-"} | inalterados: ${report.unchanged.length} | removidos: ${report.removed.join(", ") || "-"}`);
  for (const q of report.quarantined) console.log(`⚠ quarentena: ${q.key} — ${q.reason}`);
  console.log(`✔ ${report.chunks} seções indexadas em ${config.dbFile}`);
}

function listKb(config: Config): void {
  const docs = loadKnowledgeBase(config.kbDir);
  for (const doc of docs) {
    console.log(`\n${doc.id} — ${doc.title} (v${doc.version}, vigência ${doc.effectiveDate}, ${doc.area})`);
    for (const s of doc.sections) console.log(`  ${s.key.padEnd(18)} ${s.heading}`);
  }
  console.log(`\n${docs.length} documentos, ${docs.reduce((n, d) => n + d.sections.length, 0)} seções.`);
}

function resolveSession(platform: Platform, userId: string | undefined, sessionId: string | undefined): string {
  if (sessionId) {
    const session = platform.sessions.get(sessionId);
    if (!session) throw new Error(`Sessão não encontrada: ${sessionId}`);
    return session.id;
  }
  if (!userId || !getUser(platform.db, userId)) {
    const users = listUsers(platform.db).map((u) => `  ${u.id}  ${u.name} — ${u.role} (${u.contract}, ${u.workModel})`).join("\n");
    throw new Error(`Informe o colaborador com --user <id>:\n${users}`);
  }
  return platform.sessions.create(userId).id;
}

async function ask(platform: Platform, userId: string | undefined, sessionId: string | undefined, message: string): Promise<void> {
  if (!message) throw new Error('Informe a mensagem: npm run ask -- --user U-001 "Quantos dias de férias eu tenho?"');
  const id = resolveSession(platform, userId, sessionId);
  const result = await chat(platform, id, message);
  if (platform.config.debug) for (const line of renderTrace(result, platform)) console.error(`\x1b[36m[debug] ${line}\x1b[0m`);
  console.log(`\n${result.text}\n\x1b[2m${footer(result)} · sessão ${id}\x1b[0m`);
}

async function interactive(platform: Platform, userId: string | undefined, sessionId: string | undefined): Promise<void> {
  let current = resolveSession(platform, userId, sessionId);
  let debug = platform.config.debug;
  const userOf = () => getUser(platform.db, platform.sessions.get(current)!.userId)!;
  let lastResult: Awaited<ReturnType<typeof chat>> | undefined;

  const user = userOf();
  console.log(`Assistente Interno Lumora — ${user.name} (${user.id}) · sessão ${current}${sessionId ? " (retomada)" : ""}`);
  console.log(`llm=${platform.llm.name} · embedder=${platform.embedder.name} · memória ${platform.features.longTermMemory ? "ligada" : "DESLIGADA"} · /ajuda para comandos`);
  if (sessionId) for (const m of platform.sessions.messages(current).slice(-4)) console.log(`\x1b[2m${m.role === "user" ? "Você" : "Assistente"}: ${m.content}\x1b[0m`);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.setPrompt("\nVocê: ");
  rl.prompt();

  conversation: for await (const line of rl) {
    const input = line.trim();
    if (!process.stdin.isTTY) console.log(input); // entrada redirecionada (roteiro): ecoa para o log ficar legível
    if (!input) {
      rl.prompt();
      continue;
    }
    try {
      if (input.startsWith("/")) {
        const [cmd = "", ...rest] = input.slice(1).split(/\s+/);
        const arg = rest.join(" ");
        const u = userOf();
        switch (cmd) {
          case "ajuda": console.log(HELP.slice(HELP.indexOf("Comandos"))); break;
          case "perfil": console.log(profileFacts(u, platform.memory.list(u.id), platform.now()).map((f) => `- ${f}`).join("\n")); break;
          case "memorias": {
            const list = platform.memory.list(u.id, { includeInactive: arg === "todas" });
            console.log(list.length ? list.map((m) => `#${m.id} [${m.status}] ${m.key ?? m.category} · usada ${m.useCount}x · ${m.content}`).join("\n") : "(nenhuma memória)");
            break;
          }
          case "lembrar": {
            const result = platform.memory.write(u.id, manualMemory(arg), current);
            console.log(result.action === "rejected" ? `Não guardei (${result.violation.ruleId}: ${result.violation.title}).` : `Memória #${result.memory.id} ${result.action}.`);
            break;
          }
          case "esquecer": console.log(platform.memory.forget(u.id, Number(arg)) ? `Memória #${arg} esquecida.` : "Memória não encontrada."); break;
          case "sessoes":
            for (const s of platform.sessions.list(u.id)) console.log(`${s.id}${s.id === current ? " (atual)" : ""} · ${s.status} · ${s.messages} msgs · ${s.firstQuestion ?? ""}`);
            break;
          case "retomar": {
            const target = platform.sessions.get(arg);
            if (!target || target.userId !== u.id) throw new Error("Sessão não encontrada para este colaborador.");
            current = target.id;
            console.log(`Sessão ${current} retomada (${platform.sessions.messages(current).length} mensagens).`);
            break;
          }
          case "nova": {
            const episode = closeSession(platform, current);
            if (episode && episode.action !== "rejected") console.log(`Memória episódica #${episode.memory.id}: ${episode.memory.content}`);
            current = platform.sessions.create(u.id).id;
            console.log(`Nova sessão ${current}.`);
            break;
          }
          case "contexto":
            if (!lastResult?.trace.context) console.log("(nenhum contexto montado ainda)");
            else for (const m of lastResult.trace.context.messages) console.log(`\n── ${m.role} ──\n${m.content}`);
            break;
          case "debug": debug = !debug; console.log(`debug ${debug ? "ligado" : "desligado"}`); break;
          case "sair": break conversation;
          default: console.log("Comando desconhecido. /ajuda");
        }
      } else {
        lastResult = await chat(platform, current, input);
        if (debug) for (const l of renderTrace(lastResult, platform)) console.error(`\x1b[36m[debug] ${l}\x1b[0m`);
        console.log(`\nAssistente: ${lastResult.text}\n\x1b[2m${footer(lastResult)}\x1b[0m`);
      }
    } catch (error) {
      console.error((error as Error).message);
    }
    rl.prompt();
  }
  rl.close();
  const episode = closeSession(platform, current);
  if (episode && episode.action !== "rejected") console.log(`\nSessão encerrada. Memória episódica gravada: ${episode.memory.content}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
