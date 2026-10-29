# Estrutura de contexto

O contexto não é um prompt fixo com variáveis. Ele é **montado a cada turno a partir de módulos independentes**, cada um
com uma única responsabilidade, posição fixa, prioridade e orçamento de tokens.

- Definição dos módulos: [src/context/modules.ts](../src/context/modules.ts).
- Montagem: [src/context/builder.ts](../src/context/builder.ts).

## Módulos

| # | Módulo | Posição | Obrigatório | Prioridade de corte | Teto (tokens) | Conteúdo | Vem de |
|---|---|---|---|---|---|---|---|
| 1 | `identidade` | system | sim | — | 200 | papel, público, "informa e não executa", canal oficial | fixo |
| 2 | `regras` | system | sim | — | 700 | R1–R7 com a diretiva de cada uma + canário | **camada de regras** (gerado) |
| 3 | `formato` | system | sim | — | 150 | tamanho da resposta, nome de tratamento, citação | **memória** (preferências fixadas) |
| 4 | `historico` | mensagens user/assistant | não | 4 | 500 | turnos recentes na íntegra | memória de sessão (janela) |
| 5 | `perfil` | user · `<perfil>` | não | 2 | 150 | cargo, vínculo, modelo de trabalho, admissão | RH + memórias que o atualizam |
| 6 | `memorias` | user · `<memorias>` | não | 3 | 250 | memórias de longo prazo relevantes para a mensagem | memória de longo prazo |
| 7 | `resumo_sessao` | user · `<resumo_sessao>` | não | 5 (sai primeiro) | 300 | resumo incremental do que saiu da janela | memória de sessão |
| 8 | `documentos` | user · `<documentos>` | não | 1 (sai por último) | 1000 | seções acima do threshold, com `[ID] Título (vN) — Seção` | conhecimento (RAG) |
| 9 | `pergunta` | user · `<pergunta>` | sim | — | 400 | mensagem atual + lembrete das regras | entrada (mascarada) |

Orçamento global padrão: **2 200 tokens** (`CONTEXT_TOKEN_BUDGET`). Na avaliação, o contexto médio ficou em ≈ 950 tokens.

## Algoritmo do builder

1. Cada módulo renderiza o próprio texto (ou `null` quando não tem nada a dizer) e é truncado no seu teto.
2. Se a soma passar do orçamento global, os módulos **opcionais** saem do menos para o mais prioritário:
   `resumo_sessao` → `historico` → `memorias` → `perfil` → `documentos`. Os obrigatórios nunca saem: comportamento e regras
   valem mais que contexto.
3. Saída:
   - `system` recebe os módulos de sistema;
   - em seguida vêm os turnos do histórico como mensagens de chat;
   - por último, um `user` com os módulos de dados e a pergunta.
4. O builder devolve também o **manifesto** (tokens e status por módulo). O `--debug`, o `/contexto` e a auditoria
   (`context_tokens`) mostram isso.

```text
contexto: ≈1127 tokens (orçamento 2200)
  identidade     system    115 tk  incluído
  regras         system    480 tk  incluído
  formato        system     89 tk  incluído
  historico      history   209 tk  incluído
  perfil         data       65 tk  incluído
  memorias       data       42 tk  incluído
  resumo_sessao  data        0 tk  vazio
  documentos     data       87 tk  incluído
  pergunta       data       40 tk  incluído
```

Este é o manifesto real do turno "Qual o meu limite de alimentação por dia nessa viagem?" da [demonstração](demonstracao.md),
onde também está o contexto completo enviado ao LLM.

## Por que esta ordem

- **Comportamento primeiro, no `system`**. Identidade, regras e formato são estáveis entre turnos, o que favorece o
  cache de prompt do provedor. Também é a posição de maior autoridade para o modelo.
- **Dados depois, no `user`, delimitados por tags**. Perfil, memórias, resumo e documentos são *dados*, nunca
  instruções. A regra R1 diz isso explicitamente, e o lembrete no fim do `<pergunta>` reforça.
- **Documentos perto da pergunta**. O trecho que fundamenta a resposta fica logo antes dela, onde modelos menores prestam
  mais atenção.
- **A preferência memorizada altera o `system`** (módulo `formato`), não o `user`. Assim "prefiro respostas curtas" vira
  instrução de comportamento, e não um dado que o modelo pode ignorar.

## Defesas embutidas na estrutura

| Ameaça | Defesa |
|---|---|
| Documento ou pergunta fecha uma tag e injeta `<sistema>` | `sanitize()` troca `<`/`>` por `‹`/`›` em todo dado não confiável (teste: "dados não confiáveis não conseguem fechar nem forjar seções"). |
| Documento ingerido com instruções embutidas | Quarentena na ingestão (detectores `document` da R1); o trecho nunca entra em `<documentos>`. |
| Memória "envenenada" ("ignore as regras anteriores…") | Guarda `memory` da R1 na escrita; a memória é rejeitada. |
| Vazamento do prompt | Canário `LUM-CANARY-7Q2X` no módulo `regras`; a guarda de saída bloqueia se ele aparecer. |
| Contexto inflado por histórico longo | Janela por orçamento + resumo incremental + corte por prioridade. |

## Reutilização

A estrutura é **reutilizável para outro domínio** sem tocar no builder:

- troque `identidade` e o conteúdo de `rules.ts` (políticas do novo domínio);
- aponte `KB_DIR` para outros documentos (front matter `id/titulo/area/versao/vigencia` + seções `## N. Título`);
- troque `data/users.json` pelo cadastro real.

Os módulos de memória, sessão, documentos e pergunta são genéricos.
