import { resolve } from "node:path";

export interface Config {
  dbFile: string;
  kbDir: string;
  usersFile: string;
  /** Score híbrido mínimo (0..1) para um trecho entrar no contexto; abaixo disso o LLM não é chamado. */
  threshold: number;
  topK: number;
  /** Peso do score vetorial no score híbrido; o restante é do score lexical. */
  vectorWeight: number;
  /** Orçamento total (aprox.) do contexto montado; módulos opcionais são cortados para caber. */
  contextTokenBudget: number;
  /** Orçamento do histórico recente da sessão; o que não cabe vira resumo. */
  historyTokenBudget: number;
  memoryTokenBudget: number;
  memoryMaxItems: number;
  debug: boolean;
  /** Força embedder local + LLM extrativo mesmo com chave configurada. */
  offline: boolean;
  /**
   * Endpoint compatível com a API da OpenAI: a própria OpenAI ou um servidor local
   * (Ollama, vLLM, llama.cpp) servindo o modelo fine-tunado — dados internos não saem da empresa.
   */
  llmBaseUrl?: string;
  apiKey?: string;
  llmModel: string;
  embeddingModel: string;
}

try {
  process.loadEnvFile();
} catch {
  // .env é opcional
}

function num(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  return Number(value);
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const env = process.env;
  const config: Config = {
    dbFile: env.DB_FILE === ":memory:" ? ":memory:" : resolve(env.DB_FILE ?? "data/platform.db"),
    kbDir: resolve(env.KB_DIR ?? "knowledge-base"),
    usersFile: resolve(env.USERS_FILE ?? "data/users.json"),
    threshold: num(env.SIMILARITY_THRESHOLD, 0.36),
    topK: num(env.TOP_K, 3),
    vectorWeight: num(env.VECTOR_WEIGHT, 0.5),
    contextTokenBudget: num(env.CONTEXT_TOKEN_BUDGET, 2200),
    historyTokenBudget: num(env.HISTORY_TOKEN_BUDGET, 500),
    memoryTokenBudget: num(env.MEMORY_TOKEN_BUDGET, 250),
    memoryMaxItems: num(env.MEMORY_MAX_ITEMS, 5),
    debug: env.DEBUG === "true",
    offline: env.OFFLINE === "true",
    llmBaseUrl: env.LLM_BASE_URL || (env.OPENAI_API_KEY ? "https://api.openai.com/v1" : undefined),
    apiKey: env.OPENAI_API_KEY || undefined,
    llmModel: env.LLM_MODEL ?? "gpt-5-mini",
    embeddingModel: env.EMBEDDING_MODEL ?? "text-embedding-3-small"
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) (config as unknown as Record<string, unknown>)[key] = value;
  }
  if (!(config.threshold >= 0 && config.threshold <= 1)) throw new Error("O threshold deve ser um número entre 0 e 1.");
  if (!(config.vectorWeight >= 0 && config.vectorWeight <= 1)) throw new Error("VECTOR_WEIGHT deve estar entre 0 e 1.");
  if (!(Number.isInteger(config.topK) && config.topK > 0)) throw new Error("O top-k deve ser um inteiro positivo.");
  return config;
}
