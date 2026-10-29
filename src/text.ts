/** Utilidades de texto compartilhadas pela busca, pela memória e pelas guardas de regras. */

const STOPWORDS = new Set(`
a o e as os um uma uns umas de da do das dos em no na nos nas ao aos para pra por pelo pela pelos pelas
com sem sobre entre ate apos que qual quais quanto quantos quantas como quando onde quem porque se ou mas mais menos muito
ja nao sim isso isto esse essa este esta aquele aquela eu voce voces ele ela eles elas me te lhe
meu minha meus minhas seu sua seus suas ser sao foi sera estar estou estao ter tem tenho ha
faco fazer faz preciso precisa posso pode podem devo deve gostaria quero queria saber existe existem
vc vcs favor ola oi bom boa dia tarde noite empresa lumora colaborador colaboradores agora caso entao
`.trim().split(/\s+/));

/** Minúsculas, sem acentos e sem caracteres invisíveis. Ordinais (85º) viram número puro. */
export function normalize(text: string): string {
  return text
    .replace(/[ºª°]/g, " ")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[​-‍⁠﻿­]/g, "")
    .toLowerCase();
}

const LEET: Record<string, string> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", "$": "s" };

/**
 * Normalização agressiva usada pelas guardas: além de `normalize`, desfaz leetspeak
 * no meio de palavras ("1gn0re" → "ignore") e colapsa espaços.
 */
export function normalizeForGuard(text: string): string {
  return normalize(text)
    .replace(/(?<=[a-z])[013457@$](?=[a-z])|(?<=\b)[013457@$](?=[a-z]{2})/g, (c) => LEET[c] ?? c)
    .replace(/\s+/g, " ");
}

/** Forma canônica para comparar fatos: tudo que não é letra/dígito vira espaço ("R$ 1.000,00" → "r 1 000 00"). */
export function canonical(text: string): string {
  return normalize(text).replace(/[^a-z0-9]+/g, " ").trim();
}

const SUFFIXES = ["amentos", "imentos", "amento", "imento", "acoes", "icoes", "mente", "acao", "icao",
  "ados", "idos", "adas", "idas", "ado", "ido", "ada", "ida", "am", "em", "ar", "er", "ir", "es", "as", "os", "a", "e", "o", "s"];

/** Stemmer leve para português: aproxima "reembolsar"/"reembolso", "férias"/"feria" etc. */
export function stem(word: string): string {
  if (word.endsWith("ns") && word.length > 5) word = `${word.slice(0, -2)}m`; // passagens → passagem
  for (const suffix of SUFFIXES) {
    if (word.endsWith(suffix) && word.length - suffix.length >= 4) return word.slice(0, -suffix.length);
  }
  return word;
}

/** Termos de busca: normalizados, sem stopwords e reduzidos ao radical. */
export function tokenize(text: string): string[] {
  return normalize(text)
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t))
    .map(stem);
}

/** Frases completas de um trecho. */
export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+(?=[A-ZÀ-Ú0-9])|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 20 && /[.!?]$/.test(s));
}

/** Estimativa de tokens (≈ 4 caracteres por token em português) — suficiente para orçamentos de contexto. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Corta um texto para caber em `maxTokens`, terminando em "…". */
export function truncateToTokens(text: string, maxTokens: number): string {
  const maxChars = maxTokens * 4;
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

/** Neutraliza delimitadores para que conteúdo não confiável não feche nem forje seções do contexto. */
export function sanitize(text: string): string {
  return text.replace(/</g, "‹").replace(/>/g, "›");
}

/** Identificadores pessoais (LGPD): CPF e e-mails pessoais. E-mails corporativos (@lumora) são públicos na base. */
export function maskPII(text: string): string {
  return text
    .replace(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, "[CPF]")
    .replace(/[\w.+-]+@(?!lumora\.)[\w-]+\.[\w.]+/g, "[EMAIL]")
    .replace(/(\(?\b\d{2}\)?\s?)\b9\d{4}-?\d{4}\b/g, "[TELEFONE]");
}

/**
 * Mascara credenciais e cartões digitados: "minha senha é Abc@1234" → "minha senha é [SEGREDO]".
 * Só valores com cara de segredo (≥ 6 caracteres com dígito ou símbolo), para não pegar "a senha é de 12 caracteres".
 */
export function maskSecrets(text: string): string {
  return text
    .replace(/\b(senha|password|token|pin)(\s+(?:do|da|de)\s+[\wÀ-ú.]+)?(\s*(?:e|é|eh|:|=)\s*)(?=\S*[\d@#$!%&*])\S{6,}/gi, "$1$2$3[SEGREDO]")
    .replace(/\b\d{4}[ .-]?\d{4}[ .-]?\d{4}[ .-]?\d{4}\b/g, "[CARTAO]");
}

/** Números relevantes de um texto (valores, prazos, percentuais), na forma canônica: "R$ 1.000,00" → "1000". */
export function numbersIn(text: string): string[] {
  return [...text.matchAll(/\d+(?:[.,]\d+)*/g)]
    .map((m) => m[0].replace(/[.,]00$/, "").replace(/\.(?=\d{3}\b)/g, "").replace(",", "."))
    .filter((n) => n.length > 0);
}

export function formatDate(date: Date): string {
  return date.toLocaleDateString("pt-BR", { timeZone: "UTC" });
}
