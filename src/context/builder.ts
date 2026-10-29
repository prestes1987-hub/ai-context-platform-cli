import type { ChatMessage } from "../llm.ts";
import { estimateTokens, sanitize, truncateToTokens } from "../text.ts";
import { MODULES, type ContextModule, type ContextState } from "./modules.ts";

export interface ManifestEntry {
  id: string;
  placement: ContextModule["placement"];
  tokens: number;
  status: "incluído" | "truncado" | "cortado (orçamento)" | "vazio";
}

export interface BuiltContext {
  messages: ChatMessage[];
  manifest: ManifestEntry[];
  totalTokens: number;
}

/**
 * Monta o contexto a partir dos módulos:
 *  1. renderiza cada módulo e aplica o teto próprio (truncando);
 *  2. se o total passar do orçamento global, corta módulos opcionais do menos para o mais prioritário;
 *  3. emite as mensagens: system (módulos de sistema), turnos do histórico, user (dados + pergunta).
 * Devolve também o manifesto (tokens e status por módulo) — o /contexto e o --debug mostram isso.
 */
export function buildContext(state: ContextState, tokenBudget: number, modules: ContextModule[] = MODULES): BuiltContext {
  const rendered = modules.map((module) => {
    const raw = module.render(state);
    if (raw === null) return { module, text: null as string | null, status: "vazio" as ManifestEntry["status"] };
    const text = truncateToTokens(raw, module.maxTokens);
    return { module, text, status: (text === raw ? "incluído" : "truncado") as ManifestEntry["status"] };
  });

  const total = () => rendered.reduce((sum, r) => sum + (r.text ? estimateTokens(r.text) : 0), 0);
  const optional = rendered.filter((r) => !r.module.required && r.text).sort((a, b) => b.module.priority - a.module.priority);
  for (const item of optional) {
    if (total() <= tokenBudget) break;
    item.text = null;
    item.status = "cortado (orçamento)";
  }

  const text = (placement: ContextModule["placement"]) => rendered.filter((r) => r.module.placement === placement && r.text).map((r) => r.text!).join("\n\n");
  const messages: ChatMessage[] = [{ role: "system", content: text("system") }];
  if (rendered.some((r) => r.module.id === "historico" && r.text)) {
    for (const m of state.history) messages.push({ role: m.role, content: m.role === "user" ? sanitize(m.content) : m.content });
  }
  messages.push({ role: "user", content: text("data") });

  return {
    messages,
    manifest: rendered.map((r) => ({ id: r.module.id, placement: r.module.placement, tokens: r.text ? estimateTokens(r.text) : 0, status: r.status })),
    totalTokens: total()
  };
}
