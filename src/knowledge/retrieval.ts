import type { Db } from "../db.ts";
import { tokenize } from "../text.ts";
import { cosine, type Embedder } from "./embeddings.ts";
import { loadChunks, type StoredChunk } from "./ingest.ts";

export interface SearchOptions {
  threshold: number;
  topK: number;
  vectorWeight: number;
}

export interface RetrievedChunk {
  chunk: StoredChunk;
  vectorScore: number;
  /** Cobertura (0..1): fração, ponderada por IDF, dos termos da consulta presentes no trecho. */
  lexicalScore: number;
  /** Score híbrido em [0, 1], comparado com o threshold. */
  score: number;
}

export interface RetrievalResult {
  query: string;
  /** Melhores candidatos (para o modo debug), inclusive os reprovados. */
  candidates: RetrievedChunk[];
  /** Trechos que passaram no threshold, fora de quarentena, limitados a top-k. */
  selected: RetrievedChunk[];
}

/**
 * Busca híbrida sobre as seções indexadas no SQLite:
 *
 *   score = w · cosseno(embedding consulta, embedding trecho) + (1 − w) · cobertura lexical
 *
 * Termos da consulta que não existem em nenhum documento ("PLR", "pet") recebem o IDF máximo e
 * derrubam a cobertura: é isso que faz o threshold separar pergunta fora da base de pergunta coberta.
 */
export class KnowledgeIndex {
  private readonly entries: Array<{ chunk: StoredChunk; terms: Set<string> }>;
  private readonly df = new Map<string, number>();

  constructor(chunks: StoredChunk[]) {
    this.entries = chunks.map((chunk) => ({ chunk, terms: new Set(tokenize(`${chunk.docTitle} ${chunk.heading} ${chunk.content}`)) }));
    for (const entry of this.entries) for (const t of entry.terms) this.df.set(t, (this.df.get(t) ?? 0) + 1);
  }

  static load(db: Db): KnowledgeIndex {
    return new KnowledgeIndex(loadChunks(db));
  }

  get size(): number {
    return this.entries.length;
  }

  private idf(term: string): number {
    const n = this.entries.length;
    const df = this.df.get(term) ?? 0;
    return Math.log(1 + (n - df + 0.5) / (df + 0.5));
  }

  async search(embedder: Embedder, query: string, options: SearchOptions): Promise<RetrievalResult> {
    if (!this.entries.length) return { query, candidates: [], selected: [] };
    const terms = [...new Set(tokenize(query))];
    const totalIdf = terms.reduce((sum, t) => sum + this.idf(t), 0);
    const [queryVector] = await embedder.embed([query]);

    const candidates = this.entries.map(({ chunk, terms: chunkTerms }): RetrievedChunk => {
      const vectorScore = Math.max(0, cosine(queryVector!, chunk.embedding));
      const lexicalScore = totalIdf ? terms.reduce((sum, t) => sum + (chunkTerms.has(t) ? this.idf(t) : 0), 0) / totalIdf : 0;
      return { chunk, vectorScore, lexicalScore, score: options.vectorWeight * vectorScore + (1 - options.vectorWeight) * lexicalScore };
    }).sort((a, b) => b.score - a.score);

    const selected = candidates.filter((c) => !c.chunk.quarantine && c.score >= options.threshold).slice(0, options.topK);
    return { query, candidates: candidates.slice(0, Math.max(5, options.topK)), selected };
  }
}
