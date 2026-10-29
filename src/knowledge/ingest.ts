import { fromBlob, getMeta, setMeta, toBlob, type Db } from "../db.ts";
import { inspect } from "../rules/guards.ts";
import type { Embedder } from "./embeddings.ts";
import { loadKnowledgeBase } from "./knowledge-base.ts";

export interface IngestReport {
  added: string[];
  updated: string[];
  unchanged: string[];
  removed: string[];
  quarantined: Array<{ key: string; reason: string }>;
  rebuilt: boolean;
  chunks: number;
}

/**
 * Ingestão incremental: pasta → seções → guarda de documentos → embeddings → SQLite.
 * Documentos com hash igual são pulados; documentos apagados da pasta saem do índice.
 * Se o modelo de embedding mudou, o índice inteiro é refeito (vetores de espaços diferentes não se comparam).
 */
export async function ingest(db: Db, embedder: Embedder, kbDir: string): Promise<IngestReport> {
  const documents = loadKnowledgeBase(kbDir);
  const report: IngestReport = { added: [], updated: [], unchanged: [], removed: [], quarantined: [], rebuilt: false, chunks: 0 };

  if (getMeta(db, "embedder") !== embedder.name) {
    report.rebuilt = getMeta(db, "embedder") !== undefined;
    db.exec("DELETE FROM chunks; DELETE FROM documents;");
    setMeta(db, "embedder", embedder.name);
  }

  const existing = new Map((db.prepare("SELECT id, doc_id, hash FROM documents").all() as Array<{ id: number; doc_id: string; hash: string }>)
    .map((r) => [r.doc_id, r]));

  for (const doc of documents) {
    const previous = existing.get(doc.id);
    existing.delete(doc.id);
    if (previous?.hash === doc.hash) {
      report.unchanged.push(doc.id);
      continue;
    }
    // O título do documento e da seção entram no texto indexado: "limite de hotel" casa com "Hospedagem e passagens".
    const texts = doc.sections.map((s) => `${doc.title} — ${s.heading}\n${s.text}`);
    const vectors = await embedder.embed(texts);

    db.exec("BEGIN");
    try {
      if (previous) db.prepare("DELETE FROM documents WHERE id = ?").run(previous.id);
      const { lastInsertRowid } = db.prepare(`INSERT INTO documents (doc_id, file, title, area, version, effective_date, hash, ingested_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(doc.id, doc.file, doc.title, doc.area, doc.version, doc.effectiveDate, doc.hash, new Date().toISOString());
      doc.sections.forEach((section, i) => {
        // Guarda de documentos: um trecho com instruções embutidas (injeção indireta) fica em quarentena.
        const violation = inspect(section.text, "document")[0];
        if (violation) report.quarantined.push({ key: section.key, reason: `${violation.ruleId}: "${violation.match}"` });
        db.prepare("INSERT INTO chunks (document_id, chunk_key, heading, content, embedding, quarantine) VALUES (?, ?, ?, ?, ?, ?)")
          .run(lastInsertRowid, section.key, section.heading, section.text, toBlob(vectors[i]!), violation ? `${violation.ruleId}: ${violation.match}` : null);
      });
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    (previous ? report.updated : report.added).push(doc.id);
  }

  for (const [docId, row] of existing) {
    db.prepare("DELETE FROM documents WHERE id = ?").run(row.id);
    report.removed.push(docId);
  }
  report.chunks = countChunks(db);
  return report;
}

export interface StoredChunk {
  key: string;
  docId: string;
  docTitle: string;
  version: string;
  heading: string;
  content: string;
  embedding: Float32Array;
  quarantine: string | null;
}

export function loadChunks(db: Db): StoredChunk[] {
  const rows = db.prepare(`
    SELECT c.chunk_key, d.doc_id, d.title, d.version, c.heading, c.content, c.embedding, c.quarantine
    FROM chunks c JOIN documents d ON d.id = c.document_id
    ORDER BY c.id
  `).all() as Array<{ chunk_key: string; doc_id: string; title: string; version: string; heading: string; content: string; embedding: Uint8Array; quarantine: string | null }>;
  return rows.map((r) => ({
    key: r.chunk_key,
    docId: r.doc_id,
    docTitle: r.title,
    version: r.version,
    heading: r.heading,
    content: r.content,
    embedding: fromBlob(r.embedding),
    quarantine: r.quarantine
  }));
}

export function countChunks(db: Db): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM chunks").get() as { n: number }).n;
}
