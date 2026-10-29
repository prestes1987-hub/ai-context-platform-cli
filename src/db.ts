import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Um único arquivo SQLite guarda as três "memórias" da plataforma:
 *
 * CONHECIMENTO  documents ── um registro por documento ingerido (hash para ingestão incremental)
 *               chunks    ── seções + embedding (Float32 em BLOB) + motivo de quarentena, se houver
 *               meta      ── modelo de embedding usado na indexação
 * MEMÓRIA       users     ── perfil estruturado do colaborador (vem do sistema de RH; aqui, do seed)
 *               sessions  ── sessões de conversa + resumo incremental das mensagens antigas
 *               messages  ── todas as mensagens (nunca apagadas)
 *               memories  ── fatos e preferências de longo prazo, com chave para substituição (supersede)
 * GOVERNANÇA    audit_log ── trilha de cada turno (texto mascarado, desfecho, regras, fontes, memórias)
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS documents (
  id             INTEGER PRIMARY KEY,
  doc_id         TEXT NOT NULL UNIQUE,
  file           TEXT NOT NULL,
  title          TEXT NOT NULL,
  area           TEXT NOT NULL,
  version        TEXT NOT NULL,
  effective_date TEXT NOT NULL,
  hash           TEXT NOT NULL,
  ingested_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chunks (
  id          INTEGER PRIMARY KEY,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  chunk_key   TEXT NOT NULL UNIQUE,
  heading     TEXT NOT NULL,
  content     TEXT NOT NULL,
  embedding   BLOB NOT NULL,
  quarantine  TEXT
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  role       TEXT NOT NULL,
  team       TEXT NOT NULL,
  contract   TEXT NOT NULL,
  work_model TEXT NOT NULL,
  start_date TEXT NOT NULL,
  city       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'active',
  summary          TEXT NOT NULL DEFAULT '',
  summarized_upto  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  role       TEXT NOT NULL,
  content    TEXT NOT NULL,
  sources    TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, id);

CREATE TABLE IF NOT EXISTS memories (
  id                INTEGER PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id),
  key               TEXT,
  category          TEXT NOT NULL,
  content           TEXT NOT NULL,
  keywords          TEXT NOT NULL,
  importance        INTEGER NOT NULL DEFAULT 3,
  status            TEXT NOT NULL DEFAULT 'active',
  superseded_by     INTEGER,
  source            TEXT NOT NULL,
  source_session_id TEXT,
  created_at        TEXT NOT NULL,
  use_count         INTEGER NOT NULL DEFAULT 0,
  last_used_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(user_id, status);

CREATE TABLE IF NOT EXISTS audit_log (
  id             INTEGER PRIMARY KEY,
  created_at     TEXT NOT NULL,
  user_id        TEXT NOT NULL,
  session_id     TEXT NOT NULL,
  message        TEXT NOT NULL,
  outcome        TEXT NOT NULL,
  rule_id        TEXT,
  violations     TEXT NOT NULL,
  sources        TEXT NOT NULL,
  memories       TEXT NOT NULL,
  context_tokens INTEGER NOT NULL
);
`;

export type Db = DatabaseSync;

export function openDb(file: string): Db {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA foreign_keys = ON;");
  if (file !== ":memory:") db.exec("PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA);
  return db;
}

export function getMeta(db: Db, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value;
}

export function setMeta(db: Db, key: string, value: string): void {
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

export function toBlob(vector: Float32Array): Uint8Array {
  return new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
}

export function fromBlob(blob: Uint8Array): Float32Array {
  // slice() copia para um buffer alinhado em 4 bytes
  return new Float32Array(blob.slice().buffer);
}

export interface AuditEntry {
  userId: string;
  sessionId: string;
  message: string;
  outcome: string;
  ruleId?: string;
  violations: string[];
  sources: string[];
  memories: number[];
  contextTokens: number;
}

export function writeAudit(db: Db, entry: AuditEntry): void {
  db.prepare(`INSERT INTO audit_log (created_at, user_id, session_id, message, outcome, rule_id, violations, sources, memories, context_tokens)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(new Date().toISOString(), entry.userId, entry.sessionId, entry.message, entry.outcome, entry.ruleId ?? null,
      JSON.stringify(entry.violations), JSON.stringify(entry.sources), JSON.stringify(entry.memories), entry.contextTokens);
}
