import type { StoredChunk } from "./knowledge/ingest.ts";
import { FIXED_RESPONSES } from "./rules/rules.ts";
import { normalize, splitSentences, tokenize } from "./text.ts";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export type ResponseStyle = "curta" | "padrao" | "detalhada";

/** Fato do colaborador disponível no contexto (perfil do RH ou memória de longo prazo). */
export interface Fact {
  origin: "perfil" | "memoria" | "episodio";
  text: string;
}

export interface LlmRequest {
  /** Contexto completo montado pelo context builder (é o que um LLM real recebe). */
  messages: ChatMessage[];
  /** Mensagem atual do colaborador (já mascarada). */
  question: string;
  /** Pergunta anterior da sessão, quando a atual é um follow-up ("E para viagem internacional?"). */
  followUpOf?: string;
  /** Campos estruturados do mesmo contexto, usados pelo LLM extrativo offline. */
  chunks: StoredChunk[];
  facts: Fact[];
  style: ResponseStyle;
  displayName: string;
}

export interface LlmProvider {
  readonly name: string;
  complete(request: LlmRequest): Promise<string>;
}

/** Qualquer endpoint `/chat/completions`: OpenAI, Ollama, vLLM (ex.: o modelo fine-tunado servido localmente). */
export class OpenAICompatibleProvider implements LlmProvider {
  readonly name: string;
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly model: string;

  constructor(options: { baseUrl: string; apiKey?: string; model: string }) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.name = `${new URL(this.baseUrl).host}:${options.model}`;
  }

  async complete(request: LlmRequest): Promise<string> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetch(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers,
          body: JSON.stringify({ model: this.model, messages: request.messages }),
          signal: AbortSignal.timeout(120_000)
        });
        if (response.status === 429 || response.status >= 500) throw new Error(`LLM: HTTP ${response.status}`);
        if (!response.ok) throw Object.assign(new Error(`LLM: HTTP ${response.status} ${await response.text()}`), { fatal: true });
        const data = await response.json() as { choices: Array<{ message: { content: string | null } }> };
        const text = data.choices[0]?.message.content?.trim();
        if (!text) throw new Error("O LLM não retornou texto.");
        return text;
      } catch (error) {
        if ((error as { fatal?: boolean }).fatal) throw error;
        lastError = error;
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      }
    }
    throw lastError;
  }
}

const PERSONAL = /\b(eu|meu|minha|meus|minhas|tenho|recebo|posso|mim|sou)\b/;
const SELF = /\b(sobre mim|meu perfil|meus dados|o que (voce )?(sabe|lembra)|voce (sabe|lembra))\b/;
const MAX_SENTENCES: Record<ResponseStyle, number> = { curta: 1, padrao: 2, detalhada: 3 };

/** Termos de um fato que realmente distinguem o colaborador (sem números nem rótulos genéricos do perfil). */
const GENERIC_FACT_TERMS = new Set(["dias", "ano", "anos", "mes", "mese", "model", "trabalh", "time", "nome", "carg", "vincul",
  "informad", "cadastr", "rh", "contrat", "clt", "casa", "period", "prefer", "chamad", "sessa", "consult"]);
const distinctive = (text: string) => tokenize(text).filter((t) => !/^\d+$/.test(t) && !GENERIC_FACT_TERMS.has(t));

/**
 * "LLM" offline e determinístico: escolhe frases dos documentos (e fatos do perfil/memória)
 * que mais se parecem com a pergunta, personaliza com os fatos do colaborador e segue a
 * preferência de formato. Ele NÃO conhece as regras — de propósito: a conformidade vem da
 * arquitetura (guardas, threshold, verificação de fundamentação), não da boa vontade do modelo.
 */
export class ExtractiveProvider implements LlmProvider {
  readonly name = "extrativo-local";

  async complete(request: LlmRequest): Promise<string> {
    const question = normalize(request.question);
    // Termos da mensagem atual mandam; os da pergunta anterior (follow-up) só completam o sentido.
    const query = new Set(tokenize(request.question));
    const previous = new Set(tokenize(request.followUpOf ?? "").filter((t) => !query.has(t)));
    const personal = PERSONAL.test(question);
    const self = SELF.test(question);
    const factTerms = new Set(personal ? request.facts.filter((f) => f.origin !== "episodio").flatMap((f) => distinctive(f.text)) : []);

    type Candidate = { text: string; docId?: string; fact?: Fact; score: number; order: number; boosted?: boolean };
    const candidates: Candidate[] = [];
    // Frase sem termo da pergunta, mas que casa com um fato do colaborador, num trecho pertinente
    // (ex.: "Novos colaboradores devem concluí-lo em até 15 dias após a admissão" para quem acabou de entrar).
    const complements: Candidate[] = [];
    let order = 0;
    for (const chunk of request.chunks) {
      const sentences = splitSentences(chunk.content).map((text) => {
        const terms = new Set(tokenize(text));
        const current = [...query].filter((t) => terms.has(t)).length;
        const context = [...previous].filter((t) => terms.has(t)).length;
        return { text, q: current ? current + 0.3 * context : 0, f: [...factTerms].filter((t) => terms.has(t) && !query.has(t) && !previous.has(t)).length };
      });
      const pertinent = sentences.some((s) => s.q > 0);
      for (const s of sentences) {
        // O fato desempata e promove frases (estagiário → "Estagiários têm direito a…"), sem atropelar a pergunta.
        if (s.q) candidates.push({ text: s.text, docId: chunk.docId, score: s.q + 0.6 * Math.min(s.f, 2), order: order++, boosted: s.f > 0 });
        else if (pertinent && s.f) complements.push({ text: s.text, docId: chunk.docId, score: s.f, order: order++ });
      }
    }
    for (const fact of request.facts) {
      const terms = new Set(tokenize(fact.text));
      const q = [...query].filter((t) => terms.has(t)).length;
      // Fatos respondem perguntas sobre o colaborador, ou qualquer pergunta quando não há documento no contexto.
      if (self || (q && (personal || !request.chunks.length))) candidates.push({ text: fact.text, fact, score: q + (self ? 2 : 0.5), order: order++ });
    }
    if (!candidates.length) return FIXED_RESPONSES.NO_CONTEXT;

    candidates.sort((a, b) => b.score - a.score || a.order - b.order);
    const best = candidates[0]!.score;
    // Se um fato do colaborador decidiu a melhor frase, as regras genéricas concorrentes saem (estagiário ≠ regra CLT).
    const margin = candidates[0]!.boosted ? 1 : 1.5;
    const picked = candidates.filter((c) => c.score >= Math.max(1, best - margin)).slice(0, self ? request.facts.length : MAX_SENTENCES[request.style]);
    if (!picked.length) return FIXED_RESPONSES.NO_CONTEXT;
    const complement = complements.sort((a, b) => b.score - a.score || a.order - b.order)[0];
    if (complement && !self && request.style !== "curta") picked.push(complement);

    // Pergunta sobre o próprio colaborador responde só com perfil/memória.
    const docs = self ? [] : picked.filter((p) => p.docId);
    const facts = picked.filter((p) => p.fact);
    const lines: string[] = [];
    if (self) {
      lines.push(`${request.displayName}, isto é o que tenho registrado sobre você:`, ...facts.map((f) => `- ${f.text}`));
    } else {
      // Personalização: cita o fato do colaborador que fez a frase escolhida ser a mais relevante.
      const usedFact = personal && docs.length
        ? request.facts.filter((f) => f.origin !== "episodio").find((f) => distinctive(f.text).some((t) => !query.has(t) && docs.some((d) => tokenize(d.text).includes(t))))
        : undefined;
      const opening = usedFact ? `${request.displayName}, considerando o seu perfil (${usedFact.text.replace(/\.$/, "")}):` : `${request.displayName},`;
      const body = [...docs, ...facts].map((p) => p.text).join(" ");
      // "Bruno, o plano…": só minimiza a inicial de palavra comum (siglas e nomes próprios como "VidaPlena" ficam).
      const lowered = /^[A-ZÀ-Ú][a-zà-ú]*\s/.test(body) && !/^[A-Z][a-z]+[A-Z]/.test(body) ? body.charAt(0).toLowerCase() + body.slice(1) : body;
      lines.push(`${opening} ${lowered}`);
    }
    const sources = [...new Set(docs.map((d) => `[${d.docId}]`)), ...(facts.length ? ["[PERFIL/MEMÓRIA]"] : [])];
    if (sources.length) lines.push(`Fonte: ${sources.join(" ")}`);
    return lines.join("\n");
  }
}

/** Devolve sempre o mesmo texto — usado nos testes para simular um LLM comprometido ou que alucina. */
export class ScriptedProvider implements LlmProvider {
  readonly name = "llm-roteirizado";
  readonly calls: LlmRequest[] = [];
  private readonly output: string;

  constructor(output: string) {
    this.output = output;
  }

  async complete(request: LlmRequest): Promise<string> {
    this.calls.push(request);
    return this.output;
  }
}
