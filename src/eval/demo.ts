import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { chat, closeSession, type TurnResult } from "../assistant.ts";
import type { Config } from "../config.ts";
import { footer, renderTrace } from "../debug.ts";
import { createPlatform } from "../platform.ts";
import { EVAL_NOW } from "./run-eval.ts";

/** Roteiro da demonstração: duas sessões do mesmo colaborador (estagiário), com memória entre elas. */
const SCRIPT: Array<{ session: number; message: string; showTrace?: boolean; showContext?: boolean }> = [
  { session: 1, message: "Oi!" },
  { session: 1, message: "Quantos dias de férias eu tenho por ano?", showTrace: true },
  { session: 1, message: "Prefiro respostas curtas." },
  { session: 1, message: "Vou viajar a trabalho para Lisboa no mês que vem." },
  { session: 1, message: "Qual o meu limite de alimentação por dia nessa viagem?", showTrace: true, showContext: true },
  { session: 1, message: "E posso pedir adiantamento?", showTrace: true },
  { session: 1, message: "Minha senha é Bruno#2026, anota aí pra eu não esquecer." },
  { session: 1, message: "Qual o valor da PLR deste ano?", showTrace: true },
  { session: 2, message: "Sobre o que falamos na última sessão?" },
  { session: 2, message: "Qual o prazo para prestar contas do adiantamento?" },
  { session: 2, message: "O que você sabe sobre mim?" }
];

export async function runDemo(config: Config): Promise<void> {
  const platform = await createPlatform({ ...config, dbFile: ":memory:" }, { now: () => EVAL_NOW });
  const userId = "U-002";
  const out: string[] = [];
  out.push("# Demonstração funcional", "");
  out.push(`> Gerado por \`npm run demo\` (LLM \`${platform.llm.name}\`, embedder \`${platform.embedder.name}\`, data fixa ${EVAL_NOW.toISOString().slice(0, 10)}).`
    + " É exatamente o que o `npm run chat -- --user U-002` mostra, com o `--debug` ligado nos turnos marcados.", "");
  out.push("Colaborador: **Bruno Lima (U-002)**, estagiário de desenvolvimento, modelo híbrido. Duas sessões: na primeira ele conversa e",
    "a plataforma aprende preferências e fatos; a segunda começa do zero, só com a memória persistida.", "");

  let session = 0;
  let sessionId = "";
  const results: TurnResult[] = [];
  for (const step of SCRIPT) {
    if (step.session !== session) {
      if (sessionId) {
        const episode = closeSession(platform, sessionId);
        if (episode && episode.action !== "rejected") out.push(`> **Sessão encerrada** → memória episódica #${episode.memory.id}: _${episode.memory.content}_`, "");
      }
      session = step.session;
      sessionId = platform.sessions.create(userId).id;
      out.push(`## Sessão ${session} (\`${sessionId}\`)`, "");
    }
    const result = await chat(platform, sessionId, step.message);
    results.push(result);
    out.push(`**Bruno:** ${step.message}`, "");
    out.push(`**Assistente:** ${result.text.replace(/\n/g, "  \n")}`, "");
    out.push(`<sub>${footer(result)}</sub>`, "");
    if (step.showTrace) out.push("<details><summary>--debug deste turno</summary>", "", "```text", ...renderTrace(result, platform), "```", "", "</details>", "");
    if (step.showContext && result.trace.context) {
      out.push("<details><summary>Contexto completo enviado ao LLM (montado pelos módulos)</summary>", "");
      for (const m of result.trace.context.messages) out.push(`**${m.role}**`, "", "```text", m.content, "```", "");
      out.push("</details>", "");
    }
  }
  closeSession(platform, sessionId);

  out.push("## Estado final da memória (`/memorias todas`)", "");
  out.push("| # | Status | Chave | Conteúdo | Origem | Usada |", "|---|---|---|---|---|---|");
  for (const m of platform.memory.list(userId, { includeInactive: true })) {
    out.push(`| ${m.id} | ${m.status} | ${m.key ?? m.category} | ${m.content.replace(/\|/g, "\\|")} | ${m.source} | ${m.useCount}x |`);
  }
  out.push("", "Repare no que **não** está aqui: a senha (mascarada como `[SEGREDO]` antes de qualquer etapa e bloqueada pela R2) e as perguntas.", "");

  out.push("## Trilha de auditoria (`audit_log`)", "");
  out.push("| Mensagem (como foi gravada) | Desfecho | Regra | Fontes | Memórias | Contexto |", "|---|---|---|---|---|---|");
  const rows = platform.db.prepare("SELECT message, outcome, rule_id, sources, memories, context_tokens FROM audit_log WHERE user_id = ? ORDER BY id").all(userId) as
    Array<{ message: string; outcome: string; rule_id: string | null; sources: string; memories: string; context_tokens: number }>;
  for (const r of rows) {
    out.push(`| ${r.message.replace(/\|/g, "\\|")} | ${r.outcome} | ${r.rule_id ?? "-"} | ${JSON.parse(r.sources).join(", ") || "-"} | ${JSON.parse(r.memories).map((id: number) => `#${id}`).join(" ") || "-"} | ${r.context_tokens || "-"} |`);
  }
  out.push("");

  const file = resolve("docs/demonstracao.md");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${out.join("\n")}\n`);
  for (const [i, step] of SCRIPT.entries()) console.log(`\nBruno: ${step.message}\nAssistente: ${results[i]!.text}\n${footer(results[i]!)}`);
  console.log("\n✔ docs/demonstracao.md");
}
