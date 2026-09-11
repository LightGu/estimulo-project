# IA no projeto: modelos, custos e alternativas

Documento técnico sobre o uso de IA generativa no projeto: onde é usada hoje, com que modelo, e se há alternativa melhor considerando custo e qualidade. Escopo restrito à IA; arquitetura geral está em `README.md` e `docs/filas.md`.

## 1. Onde a IA é usada hoje

Três agentes distintos, cada um com sua própria cascata de modelos Gemini, configuráveis pela tela de Configurações e persistidos em `settings.ai_agents` (jsonb). Definição em `src/services/ai/ai-settings.service.js` e execução em `src/services/ai/gemini-adapter.js`.

| Agente | Tarefa | Entrada | Cascata padrão |
|---|---|---|---|
| `transcription` | Transcrever a fala do vídeo | Áudio extraído do vídeo (ffmpeg, mono/16 kHz) | `gemini-3.5-flash` → `gemini-3.1-flash-lite` → `gemini-flash-latest` |
| `caption_generation` | Gerar a legenda de WhatsApp a partir da transcrição | Texto da transcrição | `gemini-3.5-flash` → `gemini-3.5-flash-lite` → `gemini-flash-latest` |
| `caption_review` | Revisar a legenda gerada contra a transcrição, checando consistência factual | Legenda + transcrição | `gemini-3.5-flash-lite` → `gemini-3.1-flash-lite` → `gemini-flash-lite-latest` |

Dois pontos de desenho que já mitigam o principal risco de operar sobre um único provedor:

- **Cascata com fallback automático.** Se um modelo retorna 404 ("no longer available to new users") ou erro equivalente, o adapter marca o modelo como aposentado em memória e tenta o próximo da lista, terminando sempre em `gemini-flash-latest`/`gemini-flash-lite-latest` como rede de segurança. Uma configuração salva com modelo descontinuado não derruba a geração.
- **Transcrição via multimodal, não pipeline de ASR separado.** O agente de transcrição não chama uma API de speech-to-text; ele envia o áudio para `generateContent` do Gemini e recebe o texto de volta no mesmo request usado depois para gerar a legenda. Isso simplifica a arquitetura (um provedor, uma chave, um adapter) às custas de não ser trivial trocar só a transcrição por outro provedor sem reestruturar o fluxo.

O único ponto sem cobertura documental antes deste arquivo: nenhum outro documento do projeto descreve essa cascata de três agentes, os modelos padrão ou onde configurá-los.

## 2. O Gemini é uma boa escolha? O que a pesquisa mostra

**Transcrição.** Comparações de terceiros (CodeSOTA, MindStudio) colocam o Gemini Flash como competitivo com Whisper large-v3 e AssemblyAI/Deepgram para transcrição multilíngue, sem um vencedor claro. Não há benchmark público específico comparando Gemini e Whisper em português brasileiro; o único número concreto de PT encontrado é Whisper large-v3 com 97,5% de acurácia de elementos-chave (CCV Brown). Ou seja, a percepção de que "o Gemini foi bem" é plausível e consistente com o que existe, mas não há evidência de que seja superior a Whisper ou AssemblyAI em português; a vantagem real do Gemini aqui é arquitetural (transcrição e geração no mesmo provedor), não de qualidade comprovada.

**Geração de texto curto em português.** O Alconost Quality Index (2026, ~3.800 avaliações) coloca o Gemini em primeiro lugar geral, mas com Claude à frente por pouco especificamente em português brasileiro, e DeepL à frente em português europeu. É um benchmark de tradução, não de geração livre de legendas, mas é o dado de qualidade em PT mais concreto disponível hoje. Leitura correta: Gemini, Claude e GPT estão numa faixa de qualidade parecida para esse tipo de texto; nenhum se destaca o suficiente para justificar trocar de provedor só por qualidade.

## 3. Alternativas gratuitas

| Tarefa | Opção | Limite |
|---|---|---|
| Transcrição | Whisper self-hosted (open-source) | Sem custo de API, mas exige GPU própria; só compensa a partir de um volume alto (dezenas de horas/mês) |
| Transcrição | Gemini free tier (mesmo modelo já em uso) | Da ordem de centenas a ~1.500 requisições/dia dependendo do modelo, 15 RPM |
| Geração/revisão de texto | Groq free tier (Llama 3.x, Qwen, GPT-OSS) | 6.000 tokens/min, 30 req/min: inviável para volume de produção, aceitável para MVP de baixíssimo volume |
| Geração/revisão de texto | Gemini free tier | Mesmo limite acima |

Para o volume atual do projeto (poucos vídeos por dia), o free tier do próprio Gemini provavelmente já cobre o uso sem custo; a limitação é taxa de requisição, não qualidade.

## 4. Alternativas pagas

| Tarefa | Opção | Preço aproximado |
|---|---|---|
| Transcrição | OpenAI Whisper API | US$ 0,006/min |
| Transcrição | OpenAI GPT-4o-mini Transcribe | US$ 0,003/min |
| Transcrição | AssemblyAI Universal-2 | ~US$ 0,15/hora |
| Transcrição | Deepgram Nova-3 | ~US$ 0,26/hora |
| Transcrição | Gemini (modelo atual) | Preço embutido no mesmo request de geração, não é uma cobrança separada |
| Geração/revisão | Gemini (linha `flash`) | ~US$ 0,75 / US$ 3,75 por milhão de tokens (entrada/saída) |
| Geração/revisão | GPT-5 mini | ~US$ 0,25 / US$ 2,00 por milhão de tokens |
| Geração/revisão | Claude Haiku 4.5 | ~US$ 1,00 / US$ 5,00 por milhão de tokens (sem suporte nativo a transcrição de áudio) |
| Geração/revisão | Groq (Llama 3.3 70B, pago) | ~US$ 0,59 / US$ 0,79 por milhão de tokens |

Preços coletados em pesquisa de setembro de 2026 e sujeitos a mudança; confirmar na página oficial do provedor antes de qualquer decisão orçamentária.

Serviços especializados de transcrição (AssemblyAI, Deepgram, Whisper API) custam menos por hora de áudio do que embutir a transcrição numa chamada Gemini avulsa, e entregam recursos como diarização que o Gemini não oferece nativamente. A vantagem do Gemini aqui não é preço, é não precisar integrar um segundo provedor.

## 5. Recomendação

Manter Gemini para as três tarefas no estágio atual do projeto. Motivos:

- O volume de vídeos é baixo o suficiente para caber no free tier ou custar poucos dólares por mês na cascata paga.
- A qualidade em português não é claramente inferior à de Claude, GPT ou Whisper nas comparações disponíveis; trocar de provedor não traria ganho comprovado.
- O custo de manter dois provedores (chaves, monitoramento de quota, tratamento de erro específico de cada API) supera a economia de trocar um agente isolado.

Trocar passa a valer a pena em dois cenários concretos, não antes:

1. **Volume de vídeos crescer significativamente** (dezenas de horas de áudio por mês). Nesse caso, migrar só a transcrição para AssemblyAI Universal-2 ou Whisper self-hosted reduz custo por hora sem tocar em geração/revisão de legenda.
2. **Necessidade de uma segunda opinião mais barata para a revisão factual**, hoje o passo mais barato da cascata (`flash-lite`). GPT-5 mini é a alternativa paga mais barata com qualidade comparável, caso se queira diversificar de provedor único para essa etapa específica.

Nenhuma mudança é urgente. O maior risco atual não é o modelo escolhido, é o limite de requisições do free tier caso o uso cresça sem que ninguém acompanhe a cota.
