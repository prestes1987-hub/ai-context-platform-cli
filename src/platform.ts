import type { Config } from "./config.ts";
import { getMeta, openDb, type Db } from "./db.ts";
import { LocalHashEmbedder, OpenAIEmbedder, type Embedder } from "./knowledge/embeddings.ts";
import { countChunks, ingest, type IngestReport } from "./knowledge/ingest.ts";
import { KnowledgeIndex } from "./knowledge/retrieval.ts";
import { ExtractiveProvider, OpenAICompatibleProvider, type LlmProvider } from "./llm.ts";
import { MemoryStore } from "./memory/long-term.ts";
import { SessionManager } from "./memory/sessions.ts";
import { seedUsers } from "./memory/users.ts";

export interface Features {
  /** Perfil + memórias de longo prazo (contexto, extração e escrita). */
  longTermMemory: boolean;
  /** Histórico e resumo da sessão no contexto. */
  sessionMemory: boolean;
}

/** Composição da plataforma: cada componente é criado aqui e injetado no pipeline (fácil de trocar em testes). */
export interface Platform {
  config: Config;
  db: Db;
  embedder: Embedder;
  llm: LlmProvider;
  index: KnowledgeIndex;
  memory: MemoryStore;
  sessions: SessionManager;
  docTitles: Map<string, string>;
  features: Features;
  now: () => Date;
  /** Resultado da ingestão automática, quando ela aconteceu ao abrir a plataforma. */
  ingestReport?: IngestReport;
}

export function createEmbedder(config: Config): Embedder {
  if (config.offline || !config.apiKey) return new LocalHashEmbedder();
  return new OpenAIEmbedder({ apiKey: config.apiKey, model: config.embeddingModel, baseUrl: "https://api.openai.com/v1" });
}

export function createLlm(config: Config): LlmProvider {
  if (config.offline || !config.llmBaseUrl) return new ExtractiveProvider();
  return new OpenAICompatibleProvider({ baseUrl: config.llmBaseUrl, apiKey: config.apiKey, model: config.llmModel });
}

export function reloadIndex(platform: Platform): void {
  platform.index = KnowledgeIndex.load(platform.db);
  platform.docTitles = new Map((platform.db.prepare("SELECT doc_id, title FROM documents").all() as Array<{ doc_id: string; title: string }>)
    .map((r) => [r.doc_id, r.title]));
}

export async function createPlatform(config: Config, options: { llm?: LlmProvider; embedder?: Embedder; now?: () => Date; features?: Partial<Features> } = {}): Promise<Platform> {
  const db = openDb(config.dbFile);
  seedUsers(db, config.usersFile);
  const now = options.now ?? (() => new Date());
  const embedder = options.embedder ?? createEmbedder(config);

  // Base vazia ou indexada com outro modelo de embedding → ingere antes de responder.
  let ingestReport: IngestReport | undefined;
  if (countChunks(db) === 0 || getMeta(db, "embedder") !== embedder.name) ingestReport = await ingest(db, embedder, config.kbDir);

  const platform: Platform = {
    config,
    db,
    embedder,
    llm: options.llm ?? createLlm(config),
    index: KnowledgeIndex.load(db),
    memory: new MemoryStore(db, now),
    sessions: new SessionManager(db, now),
    docTitles: new Map(),
    features: { longTermMemory: true, sessionMemory: true, ...options.features },
    now,
    ingestReport
  };
  reloadIndex(platform);
  return platform;
}
