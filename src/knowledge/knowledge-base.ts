import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

/** Documento interno (política, processo ou manual) com metadados de governança do front matter. */
export interface KbDocument {
  id: string;
  title: string;
  area: string;
  version: string;
  effectiveDate: string;
  file: string;
  hash: string;
  sections: KbSection[];
}

/**
 * Unidade de conhecimento: uma seção numerada ("## 2. Fracionamento").
 * Seções de política são curtas e autocontidas, então a seção inteira é o trecho —
 * nenhuma regra fica cortada pela metade e o ID ("POL-FERIAS §2") é estável e citável.
 */
export interface KbSection {
  key: string;
  heading: string;
  text: string;
}

function parseFrontMatter(raw: string, file: string): { meta: Record<string, string>; body: string } {
  const match = raw.replace(/\r\n/g, "\n").match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) throw new Error(`${file}: cabeçalho (front matter) ausente.`);
  const meta: Record<string, string> = {};
  for (const line of match[1]!.split("\n")) {
    const sep = line.indexOf(":");
    if (sep > 0) meta[line.slice(0, sep).trim()] = line.slice(sep + 1).trim();
  }
  return { meta, body: match[2]! };
}

export function loadKnowledgeBase(dir: string): KbDocument[] {
  const files = readdirSync(dir).filter((f) => /\.(md|txt)$/i.test(f)).sort();
  if (!files.length) throw new Error(`Nenhum documento .md/.txt em ${dir}.`);
  const documents: KbDocument[] = [];

  for (const file of files) {
    const raw = readFileSync(join(dir, file), "utf8");
    const { meta, body } = parseFrontMatter(raw, file);
    const id = meta.id ?? basename(file).replace(/\.\w+$/, "");
    if (documents.some((d) => d.id === id)) throw new Error(`ID de documento duplicado: ${id}`);

    const sections: KbSection[] = [];
    for (const block of body.split(/^## /m).slice(1)) {
      const [headingLine = "", ...rest] = block.split("\n");
      const heading = headingLine.trim();
      const number = heading.match(/^(\d+)\./)?.[1];
      if (!number) throw new Error(`${file}: seção sem numeração ("${heading}").`);
      sections.push({ key: `${id} §${number}`, heading, text: rest.join("\n").trim() });
    }
    documents.push({
      id,
      title: meta.titulo ?? file,
      area: meta.area ?? "",
      version: meta.versao ?? "",
      effectiveDate: meta.vigencia ?? "",
      file,
      hash: createHash("sha256").update(raw).digest("hex"),
      sections
    });
  }
  return documents;
}
