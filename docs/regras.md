# Camada de regras

Fonte única: [src/rules/rules.ts](../src/rules/rules.ts). Cada regra declara, num só lugar:

- a **diretiva**, que o módulo `regras` injeta no system prompt;
- os **detectores** por estágio do pipeline;
- a **resposta segura** usada quando a regra bloqueia.

Mudar uma política é mudar um objeto. O prompt, as guardas, a quarentena de documentos e o filtro de memória acompanham
a mudança.

## Regras e onde cada uma é imposta

| Regra | Política | Entrada | Saída | Documento | Memória | Como é imposta |
|---|---|:-:|:-:|:-:|:-:|---|
| **R1** | Integridade: anti prompt injection, sigilo do prompt | ✔ | ✔ canário | ✔ quarentena | ✔ | bloqueio na entrada; trecho em quarentena; memória rejeitada; tags sanitizadas; canário na saída |
| **R2** | Confidencialidade e LGPD | ✔ | — | — | ✔ | `maskSecrets`/`maskPII` antes de tudo; bloqueio de pedidos de dados de colegas e de credenciais; dados sensíveis nunca memorizados |
| **R3** | Relatos de ética/assédio → Canal de Ética | ✔ | — | — | ✔ | resposta acolhedora com o canal (POL-CONDUTA §3); o relato **não é armazenado** (histórico e auditoria guardam só um marcador) |
| **R4** | Sem aconselhamento jurídico/médico/financeiro | ✔ | — | — | — | resposta institucional que encaminha à área responsável |
| **R5** | Respostas fundamentadas e citadas (anti-alucinação) | — | ✔ | — | — | threshold da busca (sem trecho ⇒ LLM não é chamado); **todo número da resposta precisa existir no contexto**; citação de documento fora do contexto ⇒ bloqueio; citação ausente ⇒ anexada pelo sistema |
| **R6** | Informa, não executa nem promete | — | ✔ | — | — | bloqueia "já aprovei", "seu pedido foi registrado", "garanto" |
| **R7** | Tom institucional | — | ✔ | — | — | bloqueia gírias; diretiva de tratamento pelo nome |

Todos os detectores rodam sobre texto normalizado: sem acentos, minúsculo, sem caracteres invisíveis e com leetspeak
desfeito (`1gn0re` → `ignore`).

## Princípio: o modelo não é confiável

A conformidade não depende de o LLM obedecer ao prompt:

1. **Antes do LLM**:
   - mascaramento;
   - guarda de entrada;
   - threshold da busca.

   Se algo bloqueia, o LLM nem é chamado. Isso também economiza custo.
2. **Durante**: diretivas no system prompt, dados delimitados e sanitizados, lembrete das regras junto da pergunta.
3. **Depois do LLM**:
   - guarda de saída;
   - verificação de fundamentação (`checkGrounding`);
   - fonte anexada pelo código.

   Em caso de bloqueio, o colaborador recebe um texto institucional fixo, nunca o texto bloqueado.

Os cenários `C01`–`C05` do [relatório](relatorio-avaliacao.md) trocam o LLM por um modelo roteirizado que vaza o prompt,
afirma ter aprovado férias, inventa R$ 180,00 e cita um documento que não estava no contexto. Todos são interceptados.

## Verificação de fundamentação (R5 na saída)

`checkGrounding(resposta, fontes, idsPermitidos)` em [src/rules/guards.ts](../src/rules/guards.ts):

- extrai os números da resposta em forma canônica (`R$ 1.000,00` → `1000`, `US$ 70,00` → `70`) e exige que cada um
  apareça nas fontes do turno: documentos, perfil, memórias, histórico ou a própria pergunta;
- extrai os IDs da linha `Fonte:` e exige que estejam entre os documentos do contexto.

Isso pega exatamente a alucinação mais cara num assistente de políticas: um valor, prazo ou percentual errado dito com
confiança. Falsos positivos são possíveis (um número correto escrito por extenso no documento, por exemplo). Por isso, o
desfecho é um bloqueio com orientação de reformular, nunca uma resposta alterada.

## Respostas fixas

| Situação | Texto |
|---|---|
| Fora da base (R5) | "Não encontrei essa informação na base de conhecimento interna. Registre um chamado no Portal do Colaborador (portal.lumora.local), na categoria da área responsável." (canal tirado de MAN-SUPORTE §1) |
| Saída bloqueada | "Não consegui gerar uma resposta que atenda às políticas da plataforma. Reformule a pergunta ou registre um chamado no Portal do Colaborador…" |
| R1–R4 | resposta segura de cada regra, em `rules.ts` |

## Auditoria

Cada turno grava em `audit_log`:

- colaborador, sessão e mensagem **mascarada** (o relato R3 não é gravado);
- desfecho e regra;
- violações por estágio;
- fontes citadas, memórias usadas e tokens de contexto.

A demonstração mostra a trilha completa ([demonstracao.md](demonstracao.md#trilha-de-auditoria-audit_log)).
