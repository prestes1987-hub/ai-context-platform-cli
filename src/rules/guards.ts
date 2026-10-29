/** Mecanismo de detecção: aplica os detectores da camada de regras a um texto, num estágio do pipeline. */
import { normalizeForGuard, numbersIn } from "../text.ts";
import { RULES, type Severity, type Stage } from "./rules.ts";

export interface Violation {
  ruleId: string;
  title: string;
  severity: Severity;
  stage: Stage;
  /** Trecho (normalizado) que disparou o detector. */
  match: string;
}

/** Violações em ordem de prioridade das regras (no máximo uma por regra). */
export function inspect(text: string, stage: Stage): Violation[] {
  const normalized = normalizeForGuard(text);
  const violations: Violation[] = [];
  for (const rule of RULES) {
    for (const pattern of rule.patterns[stage] ?? []) {
      const match = normalized.match(pattern);
      if (match) {
        violations.push({ ruleId: rule.id, title: rule.title, severity: rule.severity, stage, match: match[0].trim() });
        break;
      }
    }
  }
  return violations;
}

export interface GroundingCheck {
  /** Números da resposta que não aparecem em nenhuma fonte do contexto (documentos, perfil, memórias). */
  unsupportedNumbers: string[];
  /** IDs citados em "Fonte:" que não estavam no contexto. */
  invalidCitations: string[];
  /** IDs de documentos do contexto efetivamente citados. */
  citations: string[];
}

export function citedIds(text: string): string[] {
  const lines = text.split("\n").filter((l) => /^\s*fontes?\s*:/i.test(l));
  return [...new Set(lines.flatMap((l) => [...l.matchAll(/\[([A-Z]+-[A-Z]+)\]/g)].map((m) => m[1]!)))];
}

/**
 * R5 aplicada na saída: verificação determinística de fundamentação.
 * Todo número da resposta precisa existir no contexto (é aí que a alucinação mais custa: valores,
 * prazos, percentuais), e toda citação precisa apontar para um documento que estava no contexto.
 */
export function checkGrounding(answer: string, sourceTexts: string[], allowedDocIds: string[]): GroundingCheck {
  const body = answer.split("\n").filter((l) => !/^\s*fontes?\s*:/i.test(l)).join("\n");
  const known = new Set(sourceTexts.flatMap(numbersIn));
  const unsupportedNumbers = [...new Set(numbersIn(body).filter((n) => !known.has(n)))];
  const cited = citedIds(answer);
  const allowed = new Set(allowedDocIds);
  return {
    unsupportedNumbers,
    invalidCitations: cited.filter((id) => !allowed.has(id)),
    citations: cited.filter((id) => allowed.has(id))
  };
}
