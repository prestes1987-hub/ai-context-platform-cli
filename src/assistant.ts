/**
 * PIPELINE DE EXECUÇÃO — um turno de conversa, do input à resposta:
 *
 *  [1] proteção da entrada: segredos e PII mascarados (nada abaixo vê o valor cru)
 *  [2] guarda de entrada (regras) ───────────────► bloqueio → resposta institucional fixa
 *  [3] small talk (saudação/agradecimento) ──────► resposta direta, sem RAG
 *  [4] extração de memória → escrita consistente (guarda de memória, supersede)
 *  [5] memória: perfil + memórias relevantes + janela/resumo da sessão
 *  [6] RAG: consulta resolvida (follow-up) → busca híbrida → threshold
 *          nada passou e não há fato do colaborador que responda → recusa padrão, LLM NÃO é chamado
 *  [7] contexto modular (orçamento por módulo) → LLM
 *  [8] guarda de saída + verificação de fundamentação (números e citações) → bloqueio ou fonte anexada
 *  [9] persistência (mensagens, uso de memória) + auditoria
 */
import { buildContext, type BuiltContext } from "./context/builder.ts";
import type { ContextState } from "./context/modules.ts";
import { writeAudit } from "./db.ts";
import type { RetrievalResult } from "./knowledge/retrieval.ts";
import type { Fact, ResponseStyle } from "./llm.ts";
import { extractMemories } from "./memory/extractor.ts";
import { SELF_QUERY, type ScoredMemory, type WriteResult } from "./memory/long-term.ts";
import type { HistoryWindow, Message } from "./memory/sessions.ts";
import { firstName, getUser, profileFacts, type UserProfile } from "./memory/users.ts";
import type { Platform } from "./platform.ts";
import { checkGrounding, inspect, type GroundingCheck, type Violation } from "./rules/guards.ts";
import { FIXED_RESPONSES, ruleById } from "./rules/rules.ts";
import { canonical, formatDate, maskPII, maskSecrets, normalize, tokenize } from "./text.ts";

export type Outcome = "answered" | "answered_from_memory" | "memory_update" | "smalltalk" | "no_context" | "blocked_input" | "blocked_output";

export interface Trace {
  maskedMessage: string;
  inputViolations: Violation[];
  memoryWrites: WriteResult[];
  memories: ScoredMemory[];
  history?: HistoryWindow;
  query?: { text: string; rewritten: boolean; previous?: string };
  retrieval?: RetrievalResult;
  context?: BuiltContext;
  rawOutput?: string;
  outputViolations: Violation[];
  grounding?: GroundingCheck;
  enforcement: string[];
}

export interface TurnResult {
  outcome: Outcome;
  ruleId?: string;
  text: string;
  sources: string[];
  trace: Trace;
}

const SMALLTALK_THANKS = /^(muito )?(obrigad[oa]|valeu|agradeco|grato|grata)\b|^(ok|certo|entendi|perfeito|show|beleza)[.!]*$/;
const SMALLTALK_HELLO = /^(oi|ola|bom dia|boa tarde|boa noite|e ai|hello|hi)[\s!.,]*$/;
const FOLLOW_UP = /^(e|mas e|e se|e quanto|e quando|e no|e na|e para|e pra|e o|e a|e os|e as|e em)\b|\b(isso|disso|nesse caso|neste caso|desse|dessa|dele|dela)\b/;
const PERSONAL = /\b(eu|meu|minha|meus|minhas|tenho|recebo|sou|mim)\b/;
const QUESTION = /\?|^(qual|quais|quanto|quantos|quantas|como|quando|onde|quem|posso|pode|tenho direito|existe|preciso|o que|me (diga|explique|fale))\b/;

function styleOf(memories: ScoredMemory[]): ResponseStyle {
  const pref = memories.find((m) => m.memory.key === "preferencia.formato")?.memory.content ?? "";
  return /curtas/.test(pref) ? "curta" : /detalhadas/.test(pref) ? "detalhada" : "padrao";
}

function displayNameOf(user: UserProfile, memories: ScoredMemory[]): string {
  const pref = memories.find((m) => m.memory.key === "preferencia.nome")?.memory.content;
  return pref?.match(/de (.+)\.$/)?.[1] ?? firstName(user);
}

/** Follow-up curto ("E para viagem internacional?") é resolvido com a pergunta anterior da sessão. */
function resolveQuery(message: string, history: Message[]): { text: string; rewritten: boolean; previous?: string } {
  const norm = normalize(message);
  if (SELF_QUERY.test(canonical(message))) return { text: message, rewritten: false };
  const lastUser = [...history].reverse().find((m) => m.role === "user");
  if (lastUser && (FOLLOW_UP.test(norm) || tokenize(message).length <= 1)) {
    return { text: `${lastUser.content} ${message}`, rewritten: true, previous: lastUser.content };
  }
  return { text: message, rewritten: false };
}

export async function chat(platform: Platform, sessionId: string, message: string): Promise<TurnResult> {
  const session = platform.sessions.get(sessionId);
  if (!session) throw new Error(`Sessão inexistente: ${sessionId}`);
  const user = getUser(platform.db, session.userId);
  if (!user) throw new Error(`Colaborador inexistente: ${session.userId}`);
  const { features, config } = platform;

  // [1] Segredos e PII nunca chegam à busca, ao LLM, ao histórico nem à auditoria.
  const masked = maskPII(maskSecrets(message.trim()));
  const trace: Trace = { maskedMessage: masked, inputViolations: [], memoryWrites: [], memories: [], outputViolations: [], enforcement: [] };
  if (masked !== message.trim()) trace.enforcement.push("R2: segredo/dado pessoal mascarado antes de qualquer processamento.");

  // Histórico ANTES de gravar a mensagem atual (para resolver follow-ups com o turno anterior).
  if (features.sessionMemory) trace.history = platform.sessions.window(sessionId, config.historyTokenBudget);
  trace.inputViolations = inspect(masked, "input");
  // R3: relatos sigilosos não ficam nem no histórico nem na auditoria — só o registro de que existiram.
  const stored = trace.inputViolations[0]?.ruleId === "R3" ? "[relato sigiloso encaminhado ao Canal de Ética — conteúdo não armazenado]" : masked;
  platform.sessions.addMessage(sessionId, "user", stored);

  const finish = (outcome: Outcome, body: string, sources: string[] = [], ruleId?: string): TurnResult => {
    const text = body.trim();
    platform.sessions.addMessage(sessionId, "assistant", text, sources);
    const used = trace.memories.filter((m) => !m.pinned || outcome === "answered").map((m) => m.memory.id);
    if (outcome === "answered" || outcome === "answered_from_memory") platform.memory.markUsed(used);
    writeAudit(platform.db, {
      userId: user.id,
      sessionId,
      message: stored,
      outcome,
      ruleId,
      violations: [...trace.inputViolations, ...trace.outputViolations].map((v) => `${v.stage}:${v.ruleId}`),
      sources,
      memories: used,
      contextTokens: trace.context?.totalTokens ?? 0
    });
    return { outcome, ruleId, text, sources, trace };
  };

  // [2] Guarda de entrada (avaliada acima): bloqueia antes de gastar busca, memória e LLM.
  const blocking = trace.inputViolations[0];
  if (blocking) {
    trace.enforcement.push(`${blocking.ruleId}: entrada bloqueada; nada desta mensagem foi memorizado.`);
    return finish("blocked_input", ruleById(blocking.ruleId).safeResponse ?? FIXED_RESPONSES.OUTPUT_BLOCKED, [], blocking.ruleId);
  }

  // [3] Small talk.
  const norm = canonical(masked);
  const memoriesForName = features.longTermMemory ? platform.memory.retrieve(user.id, "", { maxItems: 3, tokenBudget: 100 }) : [];
  if (SMALLTALK_HELLO.test(norm)) {
    return finish("smalltalk", `Olá, ${displayNameOf(user, memoriesForName)}! Posso ajudar com políticas, benefícios, processos, onboarding e suporte de TI da Lumora.`);
  }
  if (SMALLTALK_THANKS.test(norm) && tokenize(masked).length <= 3) {
    return finish("smalltalk", `Por nada, ${displayNameOf(user, memoriesForName)}! Se surgir outra dúvida, é só perguntar.`);
  }

  // [4] Memória de longo prazo: fatos novos valem já para esta resposta.
  if (features.longTermMemory) {
    for (const candidate of extractMemories(masked, formatDate(platform.now()))) {
      const result = platform.memory.write(user.id, candidate, sessionId);
      trace.memoryWrites.push(result);
      if (result.action === "rejected") trace.enforcement.push(`${result.violation.ruleId}: memória candidata descartada ("${candidate.content}").`);
    }
  }
  const isQuestion = QUESTION.test(normalize(masked));
  const written = trace.memoryWrites.filter((w) => w.action !== "rejected");
  if (!isQuestion && trace.memoryWrites.length) {
    const name = displayNameOf(user, features.longTermMemory ? platform.memory.retrieve(user.id, "", { maxItems: 3, tokenBudget: 100 }) : []);
    const lines = written.map((w) => `- ${w.memory.content}${w.action === "superseded" ? ` (substitui: "${w.previous.content}")` : ""}`);
    const body = written.length
      ? `Anotado, ${name}! Vou considerar isto nas próximas respostas:\n${lines.join("\n")}\nPara ver ou apagar o que guardei, use /memorias e /esquecer.`
      : `${name}, por segurança não guardei essa informação na memória (dados sensíveis não são armazenados).`;
    return finish("memory_update", body);
  }

  // [5] Memória: perfil + memórias relevantes + histórico.
  trace.memories = features.longTermMemory
    ? platform.memory.retrieve(user.id, masked, { maxItems: config.memoryMaxItems, tokenBudget: config.memoryTokenBudget })
    : [];
  const activeMemories = features.longTermMemory ? platform.memory.list(user.id) : [];
  const profile = features.longTermMemory ? profileFacts(user, activeMemories, platform.now()) : [];
  const facts: Fact[] = [
    ...profile.map((text): Fact => ({ origin: "perfil", text })),
    ...trace.memories.filter((m) => !m.pinned).map((m): Fact => ({ origin: m.memory.category === "episodio" ? "episodio" : "memoria", text: m.memory.content }))
  ];
  const history = trace.history?.recent ?? [];

  // [6] RAG.
  trace.query = resolveQuery(masked, history);
  if (trace.query.rewritten) trace.enforcement.push("Consulta de follow-up resolvida com a pergunta anterior da sessão.");
  trace.retrieval = await platform.index.search(platform.embedder, trace.query.text, {
    threshold: config.threshold, topK: config.topK, vectorWeight: config.vectorWeight
  });
  const chunks = trace.retrieval.selected;
  const questionTerms = new Set(tokenize(masked));
  const personal = PERSONAL.test(normalize(masked));
  const factAnswers = SELF_QUERY.test(norm)
    || (personal && facts.some((f) => tokenize(f.text).some((t) => questionTerms.has(t))))
    || trace.memories.some((m) => !m.pinned && m.relevance >= 0.5);
  if (!chunks.length && !(factAnswers && facts.length)) {
    trace.enforcement.push("R5: nenhum trecho acima do threshold e nenhum fato do colaborador responde → recusa padrão, LLM não chamado.");
    return finish("no_context", FIXED_RESPONSES.NO_CONTEXT, [], "R5");
  }

  // [7] Contexto modular → LLM.
  const style = styleOf(trace.memories);
  const displayName = displayNameOf(user, trace.memories);
  const state: ContextState = {
    displayName,
    profileFacts: profile,
    memories: trace.memories,
    summary: trace.history?.summary ?? "",
    history,
    chunks,
    question: masked,
    style
  };
  trace.context = buildContext(state, config.contextTokenBudget);
  trace.rawOutput = await platform.llm.complete({
    messages: trace.context.messages,
    question: masked,
    followUpOf: trace.query.previous,
    chunks: chunks.map((c) => c.chunk),
    facts,
    style,
    displayName
  });

  // [8] Guarda de saída + fundamentação: o modelo pode errar ou ser manipulado; a saída é sempre verificada.
  trace.outputViolations = inspect(trace.rawOutput, "output");
  if (trace.outputViolations.length) {
    trace.enforcement.push(`${trace.outputViolations[0]!.ruleId}: resposta do modelo bloqueada na guarda de saída.`);
    return finish("blocked_output", FIXED_RESPONSES.OUTPUT_BLOCKED, [], trace.outputViolations[0]!.ruleId);
  }
  if (canonical(trace.rawOutput).startsWith(canonical(FIXED_RESPONSES.NO_CONTEXT).slice(0, 40))) {
    return finish("no_context", FIXED_RESPONSES.NO_CONTEXT, [], "R5");
  }
  const sourceTexts = [...chunks.map((c) => `${c.chunk.heading} ${c.chunk.content}`), ...facts.map((f) => f.text), masked, ...history.map((m) => m.content)];
  trace.grounding = checkGrounding(trace.rawOutput, sourceTexts, chunks.map((c) => c.chunk.docId));
  if (trace.grounding.unsupportedNumbers.length || trace.grounding.invalidCitations.length) {
    const why = trace.grounding.unsupportedNumbers.length
      ? `números sem respaldo no contexto (${trace.grounding.unsupportedNumbers.join(", ")})`
      : `citação de documento fora do contexto (${trace.grounding.invalidCitations.join(", ")})`;
    trace.outputViolations.push({ ruleId: "R5", title: ruleById("R5").title, severity: "crítica", stage: "output", match: why });
    trace.enforcement.push(`R5: resposta bloqueada — ${why}.`);
    return finish("blocked_output", FIXED_RESPONSES.OUTPUT_BLOCKED, [], "R5");
  }

  let body = trace.rawOutput;
  let sources = trace.grounding.citations;
  if (chunks.length && !sources.length && !/fonte/i.test(body)) {
    sources = [...new Set(chunks.map((c) => c.chunk.docId))];
    body += `\nFonte: ${sources.map((s) => `[${s}]`).join(" ")}`;
    trace.enforcement.push("R5: o modelo não citou a fonte; citação anexada pelo sistema.");
  }
  return finish(sources.length ? "answered" : "answered_from_memory", body, sources);
}

/** Encerra a sessão gravando a memória episódica (o que foi consultado). */
export function closeSession(platform: Platform, sessionId: string): WriteResult | undefined {
  const session = platform.sessions.get(sessionId);
  if (!session) return undefined;
  const episode = platform.sessions.close(sessionId, platform.docTitles);
  return episode && platform.features.longTermMemory ? platform.memory.write(session.userId, episode, sessionId) : undefined;
}
