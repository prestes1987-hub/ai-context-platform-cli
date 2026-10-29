import { normalize } from "../text.ts";
import type { MemoryCandidate } from "./long-term.ts";

/**
 * Extrator de fatos duráveis (determinístico): só grava o que muda respostas futuras —
 * preferências de interação e fatos pessoais que alteram qual política se aplica
 * (modelo de trabalho, filhos, casamento, viagem a serviço, time).
 * Perguntas não viram memória. A guarda de memória (camada de regras) ainda filtra o que sair daqui.
 */

const INTERNATIONAL = /\b(exterior|internacional|lisboa|portugal|londres|inglaterra|paris|franca|madri|espanha|berlim|alemanha|nova york|miami|eua|estados unidos|canada|mexico|buenos aires|argentina|santiago|chile|toquio|japao)\b/;

const NUMBERS: Record<string, number> = { um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4 };

interface Extractor {
  pattern: RegExp;
  build(match: RegExpMatchArray, text: string, today: string): MemoryCandidate | undefined;
}

const EXTRACTORS: Extractor[] = [
  {
    pattern: /\bprefiro (respostas? )?(mais )?(curtas?|diretas?|objetivas?|resumidas?|rapidas?)\b/,
    build: () => ({ key: "preferencia.formato", category: "preferencia", content: "Prefere respostas curtas e diretas.", keywords: ["formato", "resposta", "curta"], importance: 4, source: "extraida" })
  },
  {
    pattern: /\bprefiro (respostas? )?(mais )?(detalhadas?|completas?|explicadas?|longas?)\b/,
    build: () => ({ key: "preferencia.formato", category: "preferencia", content: "Prefere respostas detalhadas, com o passo a passo.", keywords: ["formato", "resposta", "detalhada"], importance: 4, source: "extraida" })
  },
  {
    pattern: /\b(me chame|pode me chamar|prefiro ser chamad[oa]) de ([a-z]+)\b/,
    build: (m, text) => {
      const raw = text.match(new RegExp(`\\b(${m[2]})\\b`, "i"))?.[1] ?? m[2]!;
      const name = raw.charAt(0).toUpperCase() + raw.slice(1);
      return { key: "preferencia.nome", category: "preferencia", content: `Prefere ser chamado(a) de ${name}.`, keywords: ["nome", "chamar"], importance: 4, source: "extraida" };
    }
  },
  {
    pattern: /\b(sou|estou|trabalho|passei a trabalhar|vou trabalhar|mudei para o modelo|agora sou|fui para o modelo)\b.{0,25}\b(100 ?% remot[oa]|totalmente remot[oa]|remot[oa]|hibrid[oa]|presencial)\b/,
    build: (m, _text, today) => {
      const model = /remot/.test(m[2]!) ? "100% remoto" : /hibrid/.test(m[2]!) ? "híbrido" : "presencial";
      return {
        key: "perfil.modelo_trabalho", category: "perfil",
        content: `Trabalha no modelo ${model} (informado em ${today}).`,
        keywords: ["modelo", "trabalho", "home", "office", "ajuda", "custo", "equipamento", "cadeira", model === "100% remoto" ? "remoto" : model === "híbrido" ? "hibrido" : "presencial"],
        importance: 4, source: "extraida"
      };
    }
  },
  {
    pattern: /\btenho (um|uma|dois|duas|tres|quatro|\d) (filh[oa]s?|bebe|crianca)s?\b(.{0,20}?\b(\d{1,2}) (anos?|mes(es)?))?/,
    build: (m) => {
      const count = NUMBERS[m[1]!] ?? Number(m[1]);
      const age = m[4] ? ` de ${m[4]} ${m[5]}` : "";
      return {
        key: "perfil.filhos", category: "perfil",
        content: `Tem ${count} ${count > 1 ? "filhos" : "filho(a)"}${age}.`,
        keywords: ["filho", "dependente", "creche", "auxilio", "plano", "saude"], importance: 4, source: "extraida"
      };
    }
  },
  {
    pattern: /\b(vou (me )?casar|meu casamento (e|sera|vai ser))\b(.{0,30}?\b(em|no dia|dia) ([0-9/]+|[a-z]+ de [a-z]+|[a-z]+))?/,
    build: (m) => ({
      key: "evento.casamento", category: "evento",
      content: `Vai se casar${m[6] ? ` (${m[6]})` : ""}.`,
      keywords: ["casamento", "licenca", "gala", "dependente", "conjuge", "plano"], importance: 3, source: "extraida"
    })
  },
  {
    pattern: /\bvou (ser (pai|mae)|ter (um )?bebe)\b/,
    build: (m) => ({
      key: "evento.nascimento", category: "evento",
      content: `Vai ser ${m[2] ?? "pai/mãe"} em breve.`,
      keywords: ["licenca", "paternidade", "maternidade", "bebe", "dependente", "nascimento"], importance: 3, source: "extraida"
    })
  },
  {
    pattern: /\bvou viajar\b(.{0,15}\b(a trabalho|a servico|pela empresa))?.{0,15}\b(para|pra) ([a-z]+( [a-z]+)?)/,
    build: (m, text) => {
      const international = INTERNATIONAL.test(normalize(text));
      const raw = text.match(/\b(?:para|pra) ([A-ZÀ-Úa-zà-ú]+(?: [A-ZÀ-Ú][a-zà-ú]+)?)/)?.[1] ?? m[4]!;
      return {
        key: "evento.viagem", category: "evento",
        content: `Tem viagem a serviço para ${raw} (${international ? "internacional" : "nacional"}).`,
        keywords: ["viagem", "reembolso", "alimentacao", "hospedagem", "hotel", "passagem", international ? "internacional" : "nacional", "adiantamento"],
        importance: 3, source: "extraida"
      };
    }
  },
  {
    pattern: /\b(sou|estou|trabalho) (do|no|na) time (de |da |do )?([a-z&]+( [a-z&]+)?)/,
    build: (m, text) => {
      const raw = text.match(/\btime (?:de |da |do )?([A-ZÀ-Úa-zà-ú&]+(?: [A-ZÀ-Úa-zà-ú&]+)?)/i)?.[1] ?? m[4]!;
      return { key: "perfil.time", category: "perfil", content: `Informou que é do time ${raw}.`, keywords: ["time", "area", "equipe"], importance: 2, source: "extraida" };
    }
  }
];

export function extractMemories(message: string, today: string): MemoryCandidate[] {
  const text = normalize(message);
  // Perguntas puras não são fatos sobre o colaborador ("sou remoto?" ≠ "sou remoto").
  const clauses = text.split(/(?<=[.!;])\s+|\s+(?:e|mas)\s+(?=(?:sou|estou|tenho|vou|prefiro|me chame|pode me chamar|trabalho)\b)/);
  const candidates: MemoryCandidate[] = [];
  for (const clause of clauses) {
    if (/\?\s*$/.test(clause) && !/\b(prefiro|me chame|pode me chamar)\b/.test(clause)) continue;
    for (const extractor of EXTRACTORS) {
      const match = clause.match(extractor.pattern);
      if (!match) continue;
      const candidate = extractor.build(match, message, today);
      if (candidate && !candidates.some((c) => c.key === candidate.key)) candidates.push(candidate);
    }
  }
  return candidates;
}

/** Comando /lembrar: nota livre do colaborador (passa pela mesma guarda de memória). */
export function manualMemory(text: string): MemoryCandidate {
  return { category: "nota", content: text.trim().replace(/([^.!?])$/, "$1."), keywords: [], importance: 3, source: "manual" };
}
