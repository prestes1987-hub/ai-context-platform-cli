# AI Context Platform CLI

Projeto prático do Módulo 3: uma **plataforma de contexto AI-first**. É o assistente interno da **Lumora Tecnologia**
(empresa fictícia) para onboarding e suporte ao colaborador, construído como sistema com estado:

- **estrutura de contexto modular**: 9 módulos com prioridade e orçamento de tokens;
- **sistema de memória**: perfil, sessão (janela + resumo), longo prazo com substituição consistente, episódica; tudo em
  SQLite;
- **camada de regras**: 7 políticas em fonte única, impostas na entrada, na saída, nos documentos e na memória;
- **integração com conhecimento**: RAG híbrido (vetorial + lexical) com threshold e citação verificada sobre 9 documentos
  internos;
- **testes de comportamento**: 40 cenários conversacionais, inclusive fora da base, adversariais e com LLM comprometido.

Zero dependências de runtime: o Node 24 executa TypeScript direto, o banco é o `node:sqlite` e as chamadas de modelo usam
`fetch`. Sem chave de API, tudo roda **offline** (embedder local + LLM extrativo determinístico).

## Entregáveis

| Entregável | Onde |
|---|---|
| Arquitetura completa (diagrama de componentes, interface, tecnologias e justificativas, fluxo ponta a ponta) | [docs/arquitetura.md](docs/arquitetura.md) |
| Estrutura de contexto documentada | [docs/estrutura-de-contexto.md](docs/estrutura-de-contexto.md) |
| Gerenciamento de contexto e memória | [docs/memoria.md](docs/memoria.md) |
| Camada de regras | [docs/regras.md](docs/regras.md) |
| Casos de uso reais | [docs/casos-de-uso.md](docs/casos-de-uso.md) |
| Testes + relatório de avaliação (gerado) | [src/eval/scenarios.ts](src/eval/scenarios.ts) → [docs/relatorio-avaliacao.md](docs/relatorio-avaliacao.md) |
| Decisão de customização (RAG × fine-tuning) | [docs/decisao-customizacao.md](docs/decisao-customizacao.md) |
| Resumo executivo | [docs/resumo-executivo.md](docs/resumo-executivo.md) |
| Demonstração funcional (gerada) | `npm run chat` · [docs/demonstracao.md](docs/demonstracao.md) |

## Resultados (`npm run eval`)

| Métrica | Plataforma completa | Sem memória |
|---|---|---|
| Cenários aprovados | **40/40** | 31/40 |
| Acurácia factual | **100%** | 70,7% |
| Citação correta | **100%** | 100% |
| Recusa correta fora da base | **100%** | 100% |
| Falsa recusa | **0%** | 11,5% |
| Regras aplicadas corretamente | **100%** | 100% |
| Violações do LLM interceptadas | **4/4** | 4/4 |

A memória melhora personalização e continuidade (+9 cenários) e não afeta segurança nem grounding: as regras e o RAG
funcionam igual com ela desligada.

## Como rodar

Requisito: Node.js ≥ 22.18 (testado no 24).

```bash
npm install
```

```bash
npm run chat -- --user U-002
```

```bash
npm run ask -- --user U-003 --debug "Qual é a minha ajuda de custo de home office?"
```

```bash
npm run eval
```

```bash
npm run demo
```

```bash
npm test
```

Na primeira execução, a base é indexada automaticamente. Depois de editar documentos, rode `npm run ingest`
(incremental) ou `npm run ingest -- --rebuild`.

| Comando | O que faz |
|---|---|
| `npm run chat -- --user <id> [--session <id>]` | conversa interativa; `--session` retoma uma sessão existente |
| `npm run ask -- --user <id> "…"` | um turno (com `--session` continua a conversa) |
| `npm run ingest` | indexa `knowledge-base/` (incremental, com quarentena) |
| `npm run kb` | lista documentos e seções |
| `npm run eval` | roda os cenários com e sem memória → `docs/relatorio-avaliacao.md` |
| `npm run demo` | conversa roteirizada em duas sessões → `docs/demonstracao.md` |
| `npm test` | 56 testes (`node:test`) |
| `npm run typecheck` | `tsc --noEmit` |

Opções: `--debug` (memória, busca, manifesto do contexto, regras aplicadas), `--no-memory` (baseline),
`--threshold`, `--top-k`, `--offline`.

Comandos no chat: `/perfil`, `/memorias [todas]`, `/lembrar <texto>`, `/esquecer <id>`, `/sessoes`, `/retomar <id>`,
`/nova`, `/contexto`, `/debug`, `/sair`.

Colaboradores de exemplo: **U-001** Ana (CLT, híbrida, recém-admitida), **U-002** Bruno (estagiário), **U-003** Carla
(CLT, 100% remota).

### Com modelo real

Copie `.env.example` para `.env`:

- **OpenAI**: `OPENAI_API_KEY` → `gpt-5-mini` + `text-embedding-3-small`.
- **Modelo local / fine-tunado**: `LLM_BASE_URL` + `LLM_MODEL` (Ollama, vLLM, llama.cpp).

Ao trocar de embedder, o índice é refeito automaticamente.

## Arquitetura em uma imagem

```text
                 ┌──────────────────────── CAMADA DE REGRAS (src/rules) ─────────────────────────┐
                 │ R1 integridade · R2 LGPD · R3 ética · R4 aconselhamento · R5 fundamentação     │
                 │ R6 não executa · R7 tom   — diretiva + detectores (input/output/document/memory)│
                 └───────┬──────────────────┬───────────────────┬──────────────────┬─────────────┘
                         │                  │                   │                  │
mensagem ─► [1] máscara ─► [2] guarda ─► [4] extração ─► [5] MEMÓRIA ─► [6] CONHECIMENTO ─► [7] CONTEXTO ─► LLM
             segredos/PII   de entrada     de fatos       perfil · sessão   busca híbrida      9 módulos
                              │            (supersede)    longo prazo        + threshold        orçamento
                              ▼                            episódica              │                  │
                      resposta fixa                                   nada passou ▼                  ▼
                      (sem LLM)                                       recusa + Portal    [8] guarda de saída +
                                                                      (sem LLM)          números/citações ─► resposta
                                                                                          [9] SQLite: mensagens,
                                                                                              memória, auditoria
```

Detalhes, diagrama de componentes e diagrama de sequência: [docs/arquitetura.md](docs/arquitetura.md).

## Estrutura

```text
src/
  cli.ts                 comandos chat | ask | ingest | kb | eval | demo
  config.ts              configuração (.env + flags)
  platform.ts            composição: db, embedder, llm, índice, memória, sessões
  assistant.ts           PIPELINE de execução (um turno, ponta a ponta)
  db.ts                  esquema SQLite (conhecimento + memória + auditoria)
  llm.ts                 provedor compatível com OpenAI, LLM extrativo offline, LLM roteirizado (testes)
  debug.ts               trace do --debug e rodapé das respostas
  text.ts                normalização, stemming, mascaramento, números
  context/               modules.ts (ESTRUTURA DE CONTEXTO) · builder.ts (orçamento + manifesto)
  memory/                users.ts · sessions.ts · long-term.ts · extractor.ts
  rules/                 rules.ts (REGRAS, fonte única) · guards.ts (detecção + fundamentação)
  knowledge/             knowledge-base.ts · ingest.ts · embeddings.ts · retrieval.ts
  eval/                  scenarios.ts (testes de comportamento) · run-eval.ts · demo.ts
  tests/                 platform.test.ts
knowledge-base/          9 documentos internos (front matter de governança + seções numeradas)
data/users.json          perfis dos colaboradores (simula o sistema de RH)
docs/                    entregáveis
```

## Limitações

- Os detectores de regras e o extrator de memória são léxicos e determinísticos. Isso é ótimo para testar e auditar,
  mas paráfrases distantes podem escapar. Há defesa em profundidade (prompt + guarda de saída), e o próximo passo é um
  classificador semântico.
- O LLM offline é extrativo: ele valida a arquitetura, não a redação. Os números do relatório medem contexto, memória,
  regras e recuperação. Com um modelo real, o mesmo conjunto de cenários serve de regressão.
- O threshold (0,36) e o peso vetorial (0,5) foram calibrados com o embedder local, observando os scores no `--debug`.
  Ao usar `text-embedding-3-small`, vale recalibrar.
- A empresa, os documentos e os colaboradores são fictícios.
