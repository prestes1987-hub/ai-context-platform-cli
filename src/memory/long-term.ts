import type { Db } from "../db.ts";
import { inspect, type Violation } from "../rules/guards.ts";
import { canonical, estimateTokens, tokenize } from "../text.ts";

export type MemoryCategory = "preferencia" | "perfil" | "evento" | "episodio" | "nota";

export interface Memory {
  id: number;
  userId: string;
  /** Slot opcional (ex.: preferencia.formato). Uma memória nova com a mesma chave substitui a anterior. */
  key: string | null;
  category: MemoryCategory;
  content: string;
  keywords: string;
  importance: number;
  status: "active" | "superseded" | "deleted";
  supersededBy: number | null;
  source: "extraida" | "manual" | "episodio";
  sourceSessionId: string | null;
  createdAt: string;
  useCount: number;
}

export interface MemoryCandidate {
  key?: string;
  category: MemoryCategory;
  content: string;
  keywords: string[];
  importance: number;
  source: Memory["source"];
}

export type WriteResult =
  | { action: "inserted"; memory: Memory }
  | { action: "superseded"; memory: Memory; previous: Memory }
  | { action: "reinforced"; memory: Memory }
  | { action: "rejected"; candidate: MemoryCandidate; violation: Violation };

export interface ScoredMemory {
  memory: Memory;
  relevance: number;
  score: number;
  /** Sempre entra no contexto (preferências de formato/tratamento orientam todas as respostas). */
  pinned: boolean;
}

type MemoryRow = {
  id: number; user_id: string; key: string | null; category: MemoryCategory; content: string; keywords: string; importance: number;
  status: Memory["status"]; superseded_by: number | null; source: Memory["source"]; source_session_id: string | null; created_at: string; use_count: number;
};

const fromRow = (r: MemoryRow): Memory => ({
  id: r.id, userId: r.user_id, key: r.key, category: r.category, content: r.content, keywords: r.keywords, importance: r.importance,
  status: r.status, supersededBy: r.superseded_by, source: r.source, sourceSessionId: r.source_session_id, createdAt: r.created_at, useCount: r.use_count
});

const PINNED_PREFIX = "preferencia.";
const LAST_SESSION_QUERY = /\b(ultima|anterior|passada) (sessao|conversa)\b/;

/** Perguntas sobre o próprio colaborador trazem todas as memórias (respeitando o orçamento). */
export const SELF_QUERY = /\b(sobre mim|meu perfil|meus dados|o que (voce )?(sabe|lembra)|voce (sabe|lembra)|lembra (de mim|que|o que))\b/;

/**
 * Memória de longo prazo, sempre escopada pelo colaborador (nenhuma consulta cruza usuários).
 * Nada é apagado fisicamente: versões antigas ficam "superseded" e esquecidas ficam "deleted" (auditável).
 */
export class MemoryStore {
  private readonly db: Db;
  private readonly now: () => Date;

  constructor(db: Db, now: () => Date = () => new Date()) {
    this.db = db;
    this.now = now;
  }

  get(id: number): Memory | undefined {
    const row = this.db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as MemoryRow | undefined;
    return row && fromRow(row);
  }

  list(userId: string, options: { includeInactive?: boolean } = {}): Memory[] {
    const sql = options.includeInactive
      ? "SELECT * FROM memories WHERE user_id = ? ORDER BY id"
      : "SELECT * FROM memories WHERE user_id = ? AND status = 'active' ORDER BY id";
    return (this.db.prepare(sql).all(userId) as MemoryRow[]).map(fromRow);
  }

  /**
   * Escrita consistente:
   *  1. guarda de memória (camada de regras): dados sensíveis, segredos, relatos sigilosos e injeções nunca são gravados;
   *  2. mesma chave ativa → a nova versão substitui a anterior (supersede);
   *  3. mesmo conteúdo → reforça a importância em vez de duplicar;
   *  4. senão, insere.
   */
  write(userId: string, candidate: MemoryCandidate, sessionId?: string): WriteResult {
    const violation = inspect(`${candidate.content} ${candidate.keywords.join(" ")}`, "memory")[0];
    if (violation) return { action: "rejected", candidate, violation };

    const active = this.list(userId);
    const same = active.find((m) => canonical(m.content) === canonical(candidate.content));
    if (same) {
      this.db.prepare("UPDATE memories SET importance = MIN(5, importance + 1) WHERE id = ?").run(same.id);
      return { action: "reinforced", memory: this.get(same.id)! };
    }

    const { lastInsertRowid } = this.db.prepare(`INSERT INTO memories (user_id, key, category, content, keywords, importance, source, source_session_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(userId, candidate.key ?? null, candidate.category, candidate.content, candidate.keywords.join(" "), candidate.importance,
        candidate.source, sessionId ?? null, this.now().toISOString());
    const memory = this.get(Number(lastInsertRowid))!;

    const previous = candidate.key ? active.find((m) => m.key === candidate.key) : undefined;
    if (previous) {
      this.db.prepare("UPDATE memories SET status = 'superseded', superseded_by = ? WHERE id = ?").run(memory.id, previous.id);
      return { action: "superseded", memory, previous };
    }
    return { action: "inserted", memory };
  }

  forget(userId: string, id: number): boolean {
    return this.db.prepare("UPDATE memories SET status = 'deleted' WHERE id = ? AND user_id = ? AND status = 'active'").run(id, userId).changes > 0;
  }

  markUsed(ids: number[]): void {
    const stmt = this.db.prepare("UPDATE memories SET use_count = use_count + 1, last_used_at = ? WHERE id = ?");
    for (const id of ids) stmt.run(this.now().toISOString(), id);
  }

  /**
   * Recuperação: relevância lexical obrigatória (termos da mensagem × conteúdo + palavras-chave),
   * reordenada por importância e recência. Preferências são fixadas (sempre entram).
   * Limites: `maxItems` memórias e `tokenBudget` tokens por turno — memória demais vira ruído.
   */
  retrieve(userId: string, message: string, options: { maxItems: number; tokenBudget: number }): ScoredMemory[] {
    const query = new Set(tokenize(message));
    const selfQuery = SELF_QUERY.test(canonical(message));
    const now = this.now().getTime();

    const scored = this.list(userId).map((memory): ScoredMemory => {
      const terms = new Set(tokenize(`${memory.content} ${memory.keywords}`));
      const hits = [...query].filter((t) => terms.has(t)).length;
      const relevance = selfQuery ? 1 : query.size ? hits / query.size : 0;
      const ageDays = (now - Date.parse(memory.createdAt)) / 86_400_000;
      const recency = Math.pow(0.5, ageDays / 90);
      const pinned = memory.key?.startsWith(PINNED_PREFIX) ?? false;
      return { memory, relevance, pinned, score: 0.7 * relevance + 0.15 * (memory.importance / 5) + 0.15 * recency };
    }).filter((s) => s.pinned || s.relevance > 0)
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.score - a.score || b.memory.id - a.memory.id);

    // "Sobre o que falamos na última sessão?" → só o episódio mais recente responde.
    if (LAST_SESSION_QUERY.test(canonical(message))) {
      const newest = Math.max(...scored.filter((s) => s.memory.category === "episodio").map((s) => s.memory.id));
      scored.splice(0, scored.length, ...scored.filter((s) => s.memory.category !== "episodio" || s.memory.id === newest));
    }

    const selected: ScoredMemory[] = [];
    let tokens = 0;
    for (const item of scored) {
      const cost = estimateTokens(item.memory.content);
      if (selected.length >= options.maxItems || tokens + cost > options.tokenBudget) continue;
      selected.push(item);
      tokens += cost;
    }
    return selected;
  }
}
