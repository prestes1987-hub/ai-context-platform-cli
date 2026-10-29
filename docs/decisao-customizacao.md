# Decisão de customização: RAG + engenharia de contexto (fine-tuning opcional)

## A decisão

**A plataforma customiza o comportamento com RAG híbrido + estrutura de contexto modular + memória + regras em código.**
O fine-tuning **não é necessário** com um modelo de API forte (`gpt-5-mini`). Ele fica como **opção suportada** para quem
precisar rodar um modelo pequeno e local. Nesse caso, entra o adaptador QLoRA já treinado no projeto anterior
(`corporate-knowledge-finetune-cli`), sem nenhuma mudança de código: só `LLM_BASE_URL`/`LLM_MODEL`.

## O que cada técnica resolve

| Necessidade | Técnica escolhida | Por que não as outras |
|---|---|---|
| **Saber** as políticas da empresa (fatos, valores, prazos) | **RAG** (busca híbrida + threshold) | As políticas mudam (cada documento tem `versao` e `vigencia`). Reindexar leva segundos; retreinar leva horas e "congela" a versão. O RAG também cita a fonte, coisa que o fine-tuning sozinho não consegue. |
| **Saber quem pergunta** (estagiário, remoto, filhos) | **Memória + perfil no contexto** | É dado por usuário e muda com o tempo. Não pode ir para os pesos do modelo (privacidade, LGPD, impossível "esquecer"). |
| **Comportar-se**: citar, recusar, formato curto, tom | **Contexto modular** (módulos `regras` e `formato`) **+ verificação no código** | Modelos de API seguem instruções de formato. O que não pode falhar (números, citações, segredos, canário) é verificado pelo código, independentemente do modelo. |
| **Comportar-se com modelo pequeno/local** | **Fine-tuning QLoRA** (opcional) | Só aqui o prompt não basta: o Qwen2.5-1.5B base ignorava o formato de citação. |

## Evidência: resultados reais do projeto anterior

Mesmo domínio e mesma base de conhecimento (Lumora, 9 documentos). Foram 20 perguntas de teste, executadas no Google
Colab (T4), com `Qwen/Qwen2.5-1.5B-Instruct` e QLoRA r=16, treinado com 50 exemplos em Parquet/JSONL:

| Modo | Acurácia factual | Citação correta | Recusa fora da base | Alucinação | Score geral |
|---|---|---|---|---|---|
| Base, sem grounding | 0,0% | 0,0% | 50,0% | 30,0% | 30,0% |
| Base, **com grounding** (só prompt) | **90,6%** | 0,0% | 50,0% | 10,0% | 57,7% |
| **Fine-tunado, com grounding** | 90,6% | **93,8%** | **75,0%** | **5,0%** | **88,6%** |
| Fine-tunado, sem grounding | 3,1% | 0,0% | 25,0% | 35,0% | 23,3% |

O que esses números ensinam:

1. **O conhecimento vem do grounding, não do treino.** Sem documentos, até o modelo fine-tunado inventa políticas (3,1%
   de acurácia). Por isso o RAG é a base e não é negociável.
2. **O fine-tuning ensina comportamento.** Citação passou de 0% para 93,8% e recusa de 50% para 75%, num modelo pequeno.
3. Num modelo grande, esse comportamento já vem do prompt. Nesta plataforma, além disso, a parte crítica do comportamento
   é **garantida pela arquitetura**:
   - a recusa fora da base acontece antes do LLM (threshold);
   - a citação é verificada e, se faltar, anexada (`checkGrounding`);
   - números sem respaldo são bloqueados.

   O fine-tuning vira um ganho de qualidade, não um requisito de segurança.

## Resultado nesta plataforma

Com o LLM extrativo offline, que **não conhece nenhuma regra**, a plataforma atinge no [relatório](relatorio-avaliacao.md):

- 100% de acurácia factual;
- 100% de citação correta;
- 100% de recusa fora da base;
- 100% das violações do LLM interceptadas.

Isso mostra que a qualidade e a segurança vêm do contexto, da memória e das regras, e não do modelo. Um LLM melhor
melhora a **redação**; a arquitetura garante a **correção**.

## Quando reconsiderar o fine-tuning

| Gatilho | Ação |
|---|---|
| Dados não podem sair da empresa (modelo local obrigatório) | Servir o adaptador LoRA (`merge_and_unload` → Ollama/vLLM) e apontar `LLM_BASE_URL`. |
| Custo por token alto em volume grande | Modelo pequeno fine-tunado + mesmo pipeline. |
| Muitos bloqueios `R5` por citação/números (medidos na auditoria) | Ampliar o dataset com exemplos dessas falhas e retreinar o comportamento. |
| Vocabulário interno muito específico que a busca não pega | Primeiro: sinônimos/embeddings melhores. Fine-tuning de embedding só depois. |

## Como plugar o modelo fine-tunado

```bash
# .env
LLM_BASE_URL=http://localhost:11434/v1
LLM_MODEL=lumora-assistente
```

O provedor `OpenAICompatibleProvider` usa o mesmo contrato `/chat/completions` para OpenAI, Ollama, vLLM e llama.cpp.
O modelo fine-tunado foi treinado com o mesmo formato de contexto (`<documentos>` com `[ID] Título — Seção` e
`<pergunta>`) que esta plataforma usa no módulo `documentos`.
