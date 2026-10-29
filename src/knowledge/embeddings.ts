import { tokenize } from "../text.ts";

export interface Embedder {
  /** Identifica o espaço vetorial; a base precisa ser reindexada se mudar. */
  readonly name: string;
  embed(texts: string[]): Promise<Float32Array[]>;
}

export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) throw new Error(`Dimensões diferentes: ${a.length} vs ${b.length}.`);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Embedding local, offline e determinístico ("hashing trick"): radicais das palavras
 * mais trigramas de caracteres, projetados em 1024 dimensões e normalizados (L2).
 */
export class LocalHashEmbedder implements Embedder {
  readonly name = "local-hash-1024";
  readonly dims = 1024;

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((t) => this.embedOne(t));
  }

  embedOne(text: string): Float32Array {
    const vector = new Float32Array(this.dims);
    for (const token of tokenize(text)) {
      vector[fnv1a(token) % this.dims] += 1;
      const padded = `#${token}#`;
      for (let i = 0; i + 3 <= padded.length; i++) vector[fnv1a(`3:${padded.slice(i, i + 3)}`) % this.dims] += 0.3;
    }
    const norm = Math.hypot(...vector);
    if (norm) for (let i = 0; i < vector.length; i++) vector[i] /= norm;
    return vector;
  }
}

export class OpenAIEmbedder implements Embedder {
  readonly name: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;

  constructor(options: { apiKey: string; model: string; baseUrl: string }) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.baseUrl = options.baseUrl;
    this.name = `openai:${options.model}`;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    const vectors: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += 64) {
      const response = await fetch(`${this.baseUrl}/embeddings`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.model, input: texts.slice(i, i + 64) })
      });
      if (!response.ok) throw new Error(`Embeddings: HTTP ${response.status} ${await response.text()}`);
      const data = await response.json() as { data: Array<{ index: number; embedding: number[] }> };
      data.data.sort((a, b) => a.index - b.index);
      vectors.push(...data.data.map((d) => Float32Array.from(d.embedding)));
    }
    return vectors;
  }
}
