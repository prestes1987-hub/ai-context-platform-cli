import type { TurnResult } from "./assistant.ts";
import type { Platform } from "./platform.ts";

/** Explica um turno etapa por etapa: o que a memória trouxe, o que a busca achou, o que foi para o contexto e o que as regras fizeram. */
export function renderTrace(result: TurnResult, platform: Platform): string[] {
  const { trace } = result;
  const lines: string[] = [];
  lines.push(`desfecho: ${result.outcome}${result.ruleId ? ` (${result.ruleId})` : ""} · llm=${platform.llm.name} · embedder=${platform.embedder.name}`);
  if (trace.maskedMessage) lines.push(`mensagem (mascarada): ${trace.maskedMessage}`);
  for (const v of trace.inputViolations) lines.push(`guarda de entrada: ${v.ruleId} "${v.match}"`);
  for (const w of trace.memoryWrites) {
    lines.push(w.action === "rejected"
      ? `memória rejeitada (${w.violation.ruleId}): ${w.candidate.content}`
      : `memória ${w.action} #${w.memory.id} [${w.memory.key ?? w.memory.category}]: ${w.memory.content}`);
  }
  if (trace.history) {
    lines.push(`sessão: ${trace.history.recent.length}/${trace.history.totalMessages} mensagens na janela · resumo ${trace.history.summary ? `${trace.history.summary.split("\n").length} linha(s)` : "vazio"}${trace.history.newlySummarized ? ` (+${trace.history.newlySummarized} msgs resumidas agora)` : ""}`);
  }
  for (const m of trace.memories) lines.push(`memória recuperada #${m.memory.id}${m.pinned ? " (fixada)" : ""} relevância ${m.relevance.toFixed(2)} score ${m.score.toFixed(2)}: ${m.memory.content}`);
  if (trace.query) lines.push(`consulta${trace.query.rewritten ? " (reescrita)" : ""}: ${trace.query.text}`);
  if (trace.retrieval) {
    lines.push(`busca híbrida (threshold ${platform.config.threshold}, top-${platform.config.topK}, peso vetorial ${platform.config.vectorWeight}):`);
    for (const c of trace.retrieval.candidates) {
      const selected = trace.retrieval.selected.includes(c);
      const mark = c.chunk.quarantine ? "✘ quarentena" : selected ? "✔ contexto" : "✘ abaixo do threshold/top-k";
      lines.push(`  ${c.chunk.key.padEnd(18)} score ${c.score.toFixed(3)} (vetor ${c.vectorScore.toFixed(3)} · lexical ${c.lexicalScore.toFixed(3)})  ${mark}`);
    }
  }
  if (trace.context) {
    lines.push(`contexto: ≈${trace.context.totalTokens} tokens (orçamento ${platform.config.contextTokenBudget})`);
    for (const m of trace.context.manifest) lines.push(`  ${m.id.padEnd(14)} ${m.placement.padEnd(8)} ${String(m.tokens).padStart(4)} tk  ${m.status}`);
  }
  if (trace.rawOutput) lines.push(`saída bruta do LLM:\n${trace.rawOutput}`);
  for (const v of trace.outputViolations) lines.push(`guarda de saída: ${v.ruleId} "${v.match}"`);
  if (trace.grounding?.citations.length) lines.push(`citações válidas: ${trace.grounding.citations.join(", ")}`);
  for (const e of trace.enforcement) lines.push(`regra aplicada → ${e}`);
  return lines;
}

/** Rodapé curto mostrado após cada resposta no chat. */
export function footer(result: TurnResult): string {
  const parts: string[] = [result.outcome];
  const retrieved = result.trace.memories.length;
  if (retrieved) parts.push(`${retrieved} memória(s) no contexto`);
  const written = result.trace.memoryWrites.filter((w) => w.action !== "rejected").length;
  if (written) parts.push(`${written} memória(s) gravada(s)`);
  if (result.trace.retrieval) parts.push(`${result.trace.retrieval.selected.length} trecho(s) da base`);
  if (result.trace.context) parts.push(`contexto ≈${result.trace.context.totalTokens} tk`);
  if (result.trace.query?.rewritten) parts.push("follow-up resolvido");
  return `↳ ${parts.join(" · ")}`;
}
