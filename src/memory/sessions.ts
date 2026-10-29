import { randomBytes } from "node:crypto";
import type { Db } from "../db.ts";
import { estimateTokens, formatDate, splitSentences, truncateToTokens } from "../text.ts";
import type { MemoryCandidate } from "./long-term.ts";

export interface Session {
  id: string;
  userId: string;
  createdAt: string;
  updatedAt: string;
  status: "active" | "closed";
  /** Resumo incremental das mensagens que saíram da janela do histórico. */
  summary: string;
  /** id da última mensagem já incorporada ao resumo. */
  summarizedUpto: number;
}

export interface Message {
  id: number;
  sessionId: string;
  role: "user" | "assistant";
  content: string;
  sources: string[];
  createdAt: string;
}

export interface HistoryWindow {
  /** Mensagens recentes, na íntegra, dentro do orçamento. */
  recent: Message[];
  summary: string;
  /** Quantas mensagens foram incorporadas ao resumo neste turno (0 = nada novo). */
  newlySummarized: number;
  totalMessages: number;
}

type SessionRow = { id: string; user_id: string; created_at: string; updated_at: string; status: Session["status"]; summary: string; summarized_upto: number };
type MessageRow = { id: number; session_id: string; role: Message["role"]; content: string; sources: string; created_at: string };

const sessionFromRow = (r: SessionRow): Session => ({
  id: r.id, userId: r.user_id, createdAt: r.created_at, updatedAt: r.updated_at, status: r.status, summary: r.summary, summarizedUpto: r.summarized_upto
});
const messageFromRow = (r: MessageRow): Message => ({
  id: r.id, sessionId: r.session_id, role: r.role, content: r.content, sources: JSON.parse(r.sources) as string[], createdAt: r.created_at
});

/** Linha do resumo para um par pergunta → resposta (determinístico, sem custo de LLM). */
function summarizePair(user: Message, assistant?: Message): string {
  const question = truncateToTokens(user.content.replace(/\s+/g, " "), 30);
  if (!assistant) return `- Colaborador: "${question}"`;
  const firstSentence = splitSentences(assistant.content)[0] ?? assistant.content.split("\n")[0]!;
  const sources = assistant.sources.length ? ` [${assistant.sources.join(", ")}]` : "";
  return `- Colaborador: "${question}" → Assistente: ${truncateToTokens(firstSentence, 40)}${sources}`;
}

/**
 * Memória de sessão (curto prazo): todas as mensagens ficam no SQLite; o contexto recebe
 * as mais recentes que cabem no orçamento e um resumo incremental das anteriores
 * (que é persistido — retomar a sessão não exige reprocessar o histórico).
 */
export class SessionManager {
  private readonly db: Db;
  private readonly now: () => Date;

  constructor(db: Db, now: () => Date = () => new Date()) {
    this.db = db;
    this.now = now;
  }

  create(userId: string): Session {
    const date = this.now().toISOString();
    const id = `S-${date.slice(0, 10).replace(/-/g, "")}-${randomBytes(3).toString("hex")}`;
    this.db.prepare("INSERT INTO sessions (id, user_id, created_at, updated_at) VALUES (?, ?, ?, ?)").run(id, userId, date, date);
    return this.get(id)!;
  }

  get(id: string): Session | undefined {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
    return row && sessionFromRow(row);
  }

  list(userId: string): Array<Session & { messages: number; firstQuestion?: string }> {
    const rows = this.db.prepare("SELECT * FROM sessions WHERE user_id = ? ORDER BY created_at DESC").all(userId) as SessionRow[];
    return rows.map((r) => {
      const stats = this.db.prepare("SELECT COUNT(*) AS n, (SELECT content FROM messages WHERE session_id = ? AND role = 'user' ORDER BY id LIMIT 1) AS first FROM messages WHERE session_id = ?")
        .get(r.id, r.id) as { n: number; first: string | null };
      return { ...sessionFromRow(r), messages: stats.n, firstQuestion: stats.first ?? undefined };
    });
  }

  messages(sessionId: string): Message[] {
    return (this.db.prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY id").all(sessionId) as MessageRow[]).map(messageFromRow);
  }

  addMessage(sessionId: string, role: Message["role"], content: string, sources: string[] = []): Message {
    const date = this.now().toISOString();
    const { lastInsertRowid } = this.db.prepare("INSERT INTO messages (session_id, role, content, sources, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(sessionId, role, content, JSON.stringify(sources), date);
    this.db.prepare("UPDATE sessions SET updated_at = ?, status = 'active' WHERE id = ?").run(date, sessionId);
    return messageFromRow(this.db.prepare("SELECT * FROM messages WHERE id = ?").get(Number(lastInsertRowid)) as MessageRow);
  }

  /**
   * Janela do histórico: do mais recente para o mais antigo enquanto couber em `tokenBudget`
   * (sempre em pares completos). O que sobra e ainda não foi resumido entra no resumo incremental.
   */
  window(sessionId: string, tokenBudget: number, maxSummaryTokens = 300): HistoryWindow {
    const session = this.get(sessionId)!;
    const all = this.messages(sessionId);
    const recent: Message[] = [];
    let tokens = 0;
    for (let i = all.length - 1; i >= 0; i--) {
      const cost = estimateTokens(all[i]!.content);
      if (tokens + cost > tokenBudget) break;
      recent.unshift(all[i]!);
      tokens += cost;
    }
    if (recent[0]?.role === "assistant") recent.shift();

    const firstRecentId = recent[0]?.id ?? Number.POSITIVE_INFINITY;
    const pending = all.filter((m) => m.id > session.summarizedUpto && m.id < firstRecentId);
    let summary = session.summary;
    if (pending.length) {
      const lines: string[] = [];
      for (let i = 0; i < pending.length; i++) {
        const m = pending[i]!;
        if (m.role !== "user") continue;
        const reply = pending[i + 1]?.role === "assistant" ? pending[i + 1] : undefined;
        lines.push(summarizePair(m, reply));
      }
      // Resumo com teto: as linhas mais antigas saem primeiro (o tópico mais recente vale mais).
      const merged = [...summary.split("\n").filter(Boolean), ...lines];
      while (merged.length > 1 && estimateTokens(merged.join("\n")) > maxSummaryTokens) merged.shift();
      summary = merged.join("\n");
      this.db.prepare("UPDATE sessions SET summary = ?, summarized_upto = ? WHERE id = ?").run(summary, pending.at(-1)!.id, sessionId);
    }
    return { recent, summary, newlySummarized: pending.length, totalMessages: all.length };
  }

  /**
   * Encerra a sessão e devolve a memória episódica ("o que foi tratado"), para que uma sessão
   * futura saiba retomar o assunto. Sessões sem resposta fundamentada não geram episódio.
   */
  close(sessionId: string, docTitles: Map<string, string>): MemoryCandidate | undefined {
    this.db.prepare("UPDATE sessions SET status = 'closed', updated_at = ? WHERE id = ?").run(this.now().toISOString(), sessionId);
    const docs = [...new Set(this.messages(sessionId).flatMap((m) => m.sources))];
    if (!docs.length) return undefined;
    const topics = docs.map((id) => `${docTitles.get(id) ?? id} [${id}]`).join("; ");
    return {
      key: `episodio.${sessionId}`,
      category: "episodio",
      content: `Na sessão ${sessionId} (${formatDate(this.now())}), consultou: ${topics}.`,
      keywords: ["ultima", "sessao", "conversa", "anterior", "falamos", "consultou", ...docs.map((d) => d.toLowerCase())],
      importance: 2,
      source: "episodio"
    };
  }
}
