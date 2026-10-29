# Resumo executivo

## O problema

Colaboradores perdem tempo procurando políticas espalhadas, abrem chamados para dúvidas já respondidas nos documentos e
recebem respostas genéricas que ignoram a situação deles. Um estagiário não tem as mesmas férias de um CLT; uma
colaboradora remota não tem a mesma ajuda de custo de um híbrido. Um chatbot comum resolve isso mal: inventa valores,
esquece a conversa e pode expor dados.

## A solução

Uma **plataforma de contexto AI-first** para o assistente interno da Lumora:

- **Conhecimento real**: 9 políticas internas (46 seções versionadas) indexadas com busca híbrida. Sem trecho relevante,
  não há resposta: a pergunta é encaminhada ao Portal do Colaborador.
- **Memória**:
  - de sessão (histórico + resumo);
  - de longo prazo (preferências e fatos que mudam a política aplicável), com substituição consistente e direito de
    esquecer;
  - episódica (o que foi tratado em cada conversa).
- **Regras em código**: 7 políticas (anti-injeção, LGPD, canal de ética, sem aconselhamento pessoal, fundamentação,
  não executar ações, tom). Valem antes, durante e depois do modelo.
- **Contexto modular**: 9 módulos com prioridade e orçamento. O comportamento (identidade, regras, formato) nunca é
  cortado, e cada turno mostra quanto custou e o que entrou.

## Resultados (`npm run eval`, 40 cenários / 47 turnos)

| Indicador | Resultado |
|---|---|
| Cenários de comportamento aprovados | **40/40** (sem memória: 31/40) |
| Acurácia factual / citação correta | **100% / 100%** |
| Recusa correta fora da base / falsa recusa | **100% / 0%** |
| Violações do LLM interceptadas (vazamento, ação falsa, valor inventado, citação falsa) | **4/4** |
| Turnos resolvidos sem chamar o LLM | 17 de 47 (bloqueios, recusas, small talk, memória) |
| Contexto médio por turno | ≈ 950 tokens |
| Testes automatizados | 56 (`npm test`) |

Sem memória, o assistente continua seguro e fundamentado, mas responde de forma genérica: perde 9 cenários, todos de
personalização e continuidade. A memória agrega valor sem afetar a segurança.

## Decisões principais

1. **RAG + engenharia de contexto em vez de fine-tuning** como estratégia principal. As políticas mudam e precisam ser
   citadas. O fine-tuning (já treinado no projeto anterior: citação 0% → 93,8% num modelo de 1,5B) fica como opção para um
   modelo local, plugável por configuração.
2. **O modelo não é confiável por padrão.** Números e citações da resposta são verificados contra o contexto. Segredos e
   relatos sensíveis nunca chegam ao modelo nem à memória.
3. **Simplicidade operacional.** Um arquivo SQLite guarda conhecimento, memória e auditoria. O projeto tem zero
   dependências de runtime e roda 100% offline para demonstração e testes.

## Riscos e próximos passos

| Risco | Mitigação atual | Próximo passo |
|---|---|---|
| Detectores de regras são léxicos (paráfrases distantes podem passar) | diretiva no prompt + guarda de saída + threshold | classificador semântico (LLM-as-judge) como guarda adicional |
| Extração de memória por padrões cobre um conjunto fixo de fatos | `/lembrar` manual + guarda de memória | extração com LLM e saída JSON estrita, mantendo a mesma guarda |
| Avaliação offline mede a arquitetura, não a redação | 40 cenários + modelo roteirizado adversário | rodar o mesmo conjunto com `gpt-5-mini` e com o modelo fine-tunado e comparar |
| Escala da busca vetorial exaustiva | suficiente até dezenas de milhares de trechos | `sqlite-vec`/pgvector atrás da interface `KnowledgeIndex` |
| Interface só em CLI | pipeline independente da interface | adaptador HTTP/Slack sobre a mesma função `chat()` |
