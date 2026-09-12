# Manutenção e Escala: o que vai precisar de dev conforme o sistema cresce

## Resumo

Este documento responde a uma pergunta prática: **em que essa plataforma vai
precisar de manutenção, quem precisa mexer e quanto tempo isso custa?**

Ele parte dos números reais de produção (11/09/2026, ver
`docs/ESTATISTICAS.md`) e percorre o código procurando os pontos que
funcionam bem no tamanho de hoje mas têm um teto identificável — teto de
grupos por campanha, de instâncias de WhatsApp, de volume de log, de cota de
IA. Para cada um: **qual o gatilho** (o número que faz o problema aparecer),
**o que exatamente quebra**, **em que arquivo se mexe** e **quanto esforço
de dev** aquilo representa.

Não é um roadmap de produto e não propõe reescrita. Vários itens aqui são
"não faça nada ainda, só saiba que existe" — e isso está dito explicitamente
em cada caso, porque antecipar escala que não vem é a forma mais cara de
manutenção que existe.

---

## 1. O tamanho do sistema hoje (linha de base)

Todo número desta seção veio de `docs/ESTATISTICAS.md`, consultado direto no
banco de produção em 11/09/2026. É contra esta linha de base que os gatilhos
das seções seguintes devem ser lidos.

| Dimensão | Hoje | Onde isso aparece no código |
|---|---|---|
| Grupos cadastrados | 112 (105 ativos) | `groups` |
| Instâncias de WhatsApp | 3, todas `open` | `whatsapp_instances` |
| Campanhas criadas (total histórico) | 185 (147 pontuais, 38 de trilha) | `campaigns` |
| Volume mensal de campanha | 24 em julho → 130 em setembro | `campaigns.status_changed_at` |
| Linhas de disparo (`logs`) | 572 | `logs` |
| Vídeos no catálogo | 216 (96% aprovados) | `video_catalog` |
| Legendas geradas por IA | 161, 100% com sucesso | `campaign_video_captions` |
| Workers em produção | 8 filas, 1 container cada | `infra/docker-compose.yml` |
| Suíte de testes | 82 arquivos | `tests/` |

O dado mais importante dessa tabela não é nenhum valor absoluto: é a
**tendência**. O volume mensal de campanha mais que quintuplicou entre julho
e setembro. Os tetos abaixo não são teóricos — são o que esse ritmo encontra
primeiro.

---

## 2. Os tetos, na ordem em que eles aparecem

### 2.1. Teto de grupos por campanha: a janela não estica

**Este é o limite que aparece antes de todos os outros.**

Uma campanha de trilha não dispara os grupos em paralelo: ela sorteia um
horário para cada grupo dentro de uma janela, respeitando um intervalo
mínimo entre um grupo e o seguinte. A conta está em
`src/queues/dispatch-jitter.js:303`:

```
tempo mínimo necessário = 1 min (primeiro envio) + (N-1) × intervalo mínimo
```

Se isso não couber na janela, `buildJitteredDispatchSchedule` **lança
`windowTooShortError` e a campanha inteira não é agendada**. Não é
degradação suave: é erro duro na cara do operador.

Com o padrão de hoje (intervalo mínimo de 1 min, máximo de 5 min — ver
`src/services/campaigns.service.js:68-77`):

| Janela | Teto absoluto (intervalo mín. de 1 min) | Capacidade realista (média de 3 min) |
|---|---|---|
| 1 hora | ~60 grupos | ~20 grupos |
| 3 horas | ~180 grupos | ~60 grupos |
| 8 horas | ~480 grupos | ~160 grupos |

Com 112 grupos, uma campanha para toda a base já **não cabe numa janela de 1
hora** no intervalo médio. Isso significa que o teto não está no futuro
distante: está a poucos meses de crescimento de cadastro.

**O ponto contraintuitivo:** adicionar um quarto ou quinto número de
WhatsApp **não aumenta essa capacidade**. O rodízio de instâncias
(`resolveInstanceForOrder`, `src/queues/dispatch-jitter.js:271`) só decide
*qual número* envia o grupo de ordem N — o cronograma continua sendo uma
linha do tempo única e serial. Os números se revezam no mesmo ritmo; eles
não criam ritmos paralelos. Quem comprar números esperando dobrar a vazão
vai descobrir que não mudou nada.

**O que fazer quando chegar lá.** Duas saídas, em ordem de custo:

1. **Barata (configuração, sem dev):** alargar a janela e/ou reduzir o
   intervalo mínimo na tela de Configurações. Resolve até o teto absoluto da
   tabela acima, com o custo de mandar mensagens mais juntas — o que é
   exatamente o comportamento que o WhatsApp penaliza.
2. **Cara (dev):** tornar o cronograma **por instância** em vez de global —
   cada número ganha sua própria linha do tempo, e N números passam a valer
   N× de capacidade real. Isso é mudança de modelo em
   `dispatch-jitter.js`, propagada para `campaign-trigger.js` e para os
   testes de jitter (`tests/dispatch-jitter*.test.js`, 3 arquivos).
   **Estimativa: 3 a 5 dias de dev**, sendo a maior parte teste — é código
   que decide quando uma mensagem real sai, e errar aqui significa spam ou
   número banido.

### 2.2. Sincronização de grupos: N+1 sequencial contra HTTP

`syncGroupsFromEvolution` (`src/services/groups.service.js:481`) tem dois
problemas que só aparecem com volume, e eles se multiplicam.

**Problema A — o laço de persistência é sequencial, um grupo por vez**
(`groups.service.js:684-723`). Para cada grupo: um `findByEvolutionGroupId`,
um `update` ou `create`, mais um `linkGroupToInstance` **por instância**.
Todas são chamadas HTTP ao PostgREST, uma esperando a outra.

| Cenário | Round-trips HTTP aproximados | Duração estimada (60ms/chamada) |
|---|---|---|
| Hoje (112 grupos × 3 números) | ~560 | ~35 s |
| 500 grupos × 3 números | ~2.500 | ~2,5 min |
| 1.000 grupos × 5 números | ~7.000 | ~7 min |

**Problema B — `getParticipants` é forçado como `true`**
(`groups.service.js:489`, e o comentário ali explica por quê: sem ele a
contagem de membros era zerada). A Evolution devolve a lista completa de
participantes de todos os grupos, de uma vez, na memória do processo. Com a
média atual de 241 membros por grupo, 1.000 grupos significam ~240 mil
entradas de participante num único JSON — dezenas de MB por instância, num
container que divide a RAM da VM com sete outros.

**O que quebra primeiro, na prática:** o botão "Sincronizar" da tela de
Grupos. `POST /groups/sync` é **síncrono** — o controller chama o serviço e
segura a requisição HTTP até terminar
(`src/api/controllers/groups.controller.js:46`). Quando o sync passar do
timeout do navegador ou do Caddy, o operador vê um erro de rede enquanto o
sync continua rodando no servidor. A sincronização noturna agendada
(`0 2 * * *`) continua funcionando por mais tempo, porque não tem ninguém
esperando do outro lado — então o sintoma vai ser "o botão não funciona
mais, mas de manhã os grupos estão atualizados", que é confuso de
diagnosticar.

**O que fazer.** Duas correções independentes:

- **Tornar o botão assíncrono** (enfileirar na fila `group-sync`, que já
  existe, e devolver 202 na hora). É a correção mais barata e a de maior
  retorno. **Estimativa: meio dia.**
- **Trocar o laço por operações em lote** (`upsert` por `evolution_group_id`
  em blocos, `linkGroupToInstance` em lote). Corta os round-trips em uma ou
  duas ordens de grandeza. **Estimativa: 1 a 2 dias**, incluindo cuidado com
  a regra de "fica com a maior contagem de membros" que hoje é resolvida em
  memória.

**Gatilho para agir:** quando o sync manual passar de ~60 segundos, ou
quando o cadastro passar de ~300 grupos — o que vier primeiro.

### 2.3. `/groups/search` sem paginação: o teto silencioso de 1.000 linhas

As telas de Grupos e Campanhas já foram paginadas (commit `e181c9a`), mas
**apenas quando o cliente pede `limit`/`offset`**. Sem esses parâmetros, a
rota devolve o array cru (`src/api/controllers/groups.controller.js:20-27`)
vindo de `searchByName` (`src/repositories/groups.repository.js:205`), que
**não tem `.limit()` nem `.range()`**.

Sete telas chamam `/groups/search` sem parâmetro nenhum:
`configuracoes.html`, `envio-automatizado.html`, `index.html`,
`mensagens.html`, `organizacoes.html`, `relatorios.html` e `trilhas.html`.
Todas carregam a base inteira de grupos para montar seletores.

O PostgREST corta a resposta no `max-rows` configurado — **1.000 linhas por
padrão no Supabase** — e faz isso **sem erro**. Passando de 1.000 grupos, o
Disparador Pontual simplesmente para de listar parte da base, e ninguém
recebe um aviso. O operador conclui que "o grupo sumiu do sistema".

**Vale conferir o valor real** de `max-rows` do projeto no painel do
Supabase antes de assumir 1.000 — mas o comportamento de truncar em
silêncio é o mesmo em qualquer valor.

**O que fazer.** Trocar os seletores por busca sob demanda (digitar filtra
no servidor) em vez de carregar tudo. **Estimativa: 2 a 3 dias** para as
sete telas, ou meio dia por tela se for feito incrementalmente. Como
mitigação imediata e quase grátis, dá para colocar um `.limit()` explícito
com ordenação estável em `searchByName` e logar quando o teto for atingido —
converte uma falha silenciosa em uma falha visível. **Estimativa: 1 hora.**

### 2.4. Adicionar um número de WhatsApp é uma operação que congela disparos

Esta é a armadilha operacional mais afiada do sistema, e ela não tem nada a
ver com volume — basta **uma pessoa adicionar um número**.

A regra em `resolveMissingCoverage`
(`src/services/whatsapp-instances.service.js:472`) exige que um grupo esteja
vinculado a **todas** as instâncias despachantes para ser elegível. O
vínculo (`group_whatsapp_instances`) só é criado pelo sync, e o sync só
enxerga um grupo pelo número que **é membro daquele grupo no WhatsApp**.

Então, no instante em que um quarto número é cadastrado e fica ativo:

1. Nenhum dos 112 grupos está vinculado a ele.
2. `filterDispatchableGroups` marca **todos** como inelegíveis.
3. As campanhas de trilha não abortam — elas **pulam todos os grupos**,
   registrando `dispatch.skipped_missing_instance_coverage` no log
   (`src/queues/campaign-trigger.js:386`).
4. O disparo pontual falha com `GROUPS_MISSING_INSTANCE_COVERAGE`.

O resultado é uma campanha que "roda com sucesso" e não envia nada. O único
sinal está no log do container — não há alerta, não há aviso na tela.

**Sair desse estado exige adicionar o número novo a todos os grupos no
WhatsApp** (trabalho manual, fora do sistema) **e rodar o sync**. Para 112
grupos isso é trabalho humano de horas ou dias. Para 500, é inviável em
tempo hábil.

**O que fazer.** Duas coisas, e a primeira é obrigatória antes do próximo
número entrar:

- **Um aviso na tela de Configurações**, no momento do cadastro, dizendo
  quantos grupos ficarão sem cobertura e que disparos vão ser pulados até o
  sync. A informação já é calculável com `resolveMissingCoverage`.
  **Estimativa: meio dia.**
- **Repensar a regra de "todas as instâncias"** para algo como "ao menos uma
  instância despachante cobre o grupo", deixando o rodízio escolher entre as
  que cobrem. É a mudança correta a médio prazo e elimina a armadilha
  inteira, mas mexe no coração da elegibilidade de disparo.
  **Estimativa: 2 a 3 dias**, com atenção aos testes de rodízio e cobertura
  (`tests/whatsapp-instances-service.test.js`,
  `tests/dispatch-jitter-instance-rotation.test.js`).

**Enquanto isso não existe:** tratar "adicionar número de WhatsApp" como
operação planejada, feita fora de janela de campanha, com o sync rodado logo
em seguida e a cobertura conferida. Não é uma tarefa de autoatendimento.

### 2.5. Sessões em arquivo: a API não escala horizontalmente

`src/api/session-store.js` guarda sessões num `Map` em memória, persistido
num JSON (`storage/sessions.json`) com `readFileSync`/escrita síncrona.

Isso funciona perfeitamente para **um** container de API — que é o que
existe hoje — e tem a virtude de sobreviver a restart. Mas fixa três
limites:

- Subir uma segunda réplica da API (`--scale api=2`) faz o usuário ser
  deslogado a cada requisição que cair no container errado.
- Escrita síncrona no laço de eventos: com muitos logins simultâneos, cada
  gravação bloqueia o processo inteiro. Irrelevante com os poucos operadores
  de hoje; perceptível com dezenas.
- O arquivo vive no volume `app-storage`. Perder o volume é deslogar todo
  mundo (recuperável, mas confuso).

**O que fazer.** Migrar as sessões para o Redis, que já está lá, já tem
persistência e já é dependência de todos os containers. **Estimativa: 1
dia.** Não é urgente — só vira pré-requisito no dia em que houver motivo
para rodar mais de uma API.

### 2.6. Cota do Gemini: o gargalo do conteúdo, não do disparo

`docs/IA_MODELOS.md` já identifica isto e a conclusão continua valendo: o
risco não é a qualidade do modelo, é a **taxa de requisição**.

A fila `campaign-captions` roda com `concurrency: 1` de propósito
(`CAMPAIGN_CAPTIONS_CONCURRENCY`) — e o comentário em `docs/filas.md:314`
explica a razão: a cota do Gemini é global do projeto, então paralelizar não
termina antes, só esgota a cota mais cedo. O `lockDuration` de 45 minutos
diz quanto tempo uma campanha grande pode legitimamente levar percorrendo
grupo por grupo (baixar vídeo → extrair áudio → transcrever → gerar →
revisar).

A conta que importa: **3 chamadas de IA por vídeo**, e o free tier gira em
torno de 15 requisições por minuto. Uma campanha com 100 grupos e vídeos
distintos são 300 chamadas — no mínimo 20 minutos só de cota, antes de somar
download e ffmpeg. Passando dos 45 minutos de lock, o job é considerado
travado e reentregue, o que refaz trabalho e gasta mais cota ainda.

**Sinal de alerta:** hoje 100% das 161 legendas foram geradas com sucesso.
O dia em que aparecerem linhas com status de falha, ou erros 429 no Sentry,
é o dia de agir.

**O que fazer.** Em ordem: (a) subir para o tier pago do Gemini — é
configuração, não dev; (b) aumentar `CAMPAIGN_CAPTIONS_JOB_LOCK_MS` junto;
(c) só se o volume crescer muito, migrar a transcrição para uma alternativa
mais barata por hora, como já sugere `docs/IA_MODELOS.md`. **Estimativa: (a)
e (b) são 1 hora; (c) são 2 a 3 dias.**

### 2.7. CPU e memória da VM: ffmpeg é o vizinho barulhento

Nenhum container tem limite de CPU ou memória em `infra/docker-compose.yml`.
Nove containers dividem a VM sem nenhuma reserva, e dois deles fazem
trabalho pesado:

- **Compressão de vídeo** (`src/services/video-compression.js`): ffmpeg com
  timeout de **20 minutos** por vídeo, até 3 tentativas, preset `veryfast`,
  saturando o núcleo enquanto roda.
- **Payload para a Evolution**: até **136 MB** em base64
  (`EVOLUTION_API_MAX_MEDIA_PAYLOAD_BYTES`), materializado como string na
  memória do worker.

Numa VM pequena — e `docs/DEPLOY_ORACLE.md:33` já avisa que shapes de 1 GB
podem não aguentar API + workers + Evolution + PostgreSQL — dois disparos
com vídeo pesado ao mesmo tempo competem por CPU e RAM com a Evolution, que
é justamente quem não pode cair: derrubá-la arrisca a sessão do WhatsApp.

**O que fazer.** Barato e imediato: `mem_limit`/`cpus` nos containers de
worker, protegendo `evolution-api` e `redis` de vizinhança ruim.
**Estimativa: 2 horas**, incluindo medir o consumo real com `docker stats`
durante uma campanha. Se o volume de vídeo crescer, o passo seguinte é tirar
os workers de mídia para uma segunda VM — o compose já separa os serviços
por profile, então é mais configuração que reescrita. **Estimativa: 1 a 2
dias.**

### 2.8. Crescimento de tabelas: `logs` nunca é apagado

`logs` só cresce. O "excluir" do relatório é lógico — marca `hidden_at`, não
remove a linha (`src/repositories/dispatch-logs.repository.js`). Não existe
expurgo, arquivamento nem particionamento em lugar nenhum do código.

A boa notícia é que os índices necessários **já existem**:
`idx_logs_criado_em`, `idx_logs_campaign_id`, `idx_logs_group_id`,
`idx_logs_campaign_group_created` e o índice único parcial
`idx_logs_trio_ativo`. E o relatório já é paginado no servidor (100 por
página, teto de 500 — `dispatch-logs.repository.js:532-541`). Com isso, o
volume por si só não degrada a tela.

A projeção: 572 linhas hoje. Uma campanha para 500 grupos gera 500 linhas.
Com o ritmo atual de crescimento de campanha, chegar a 50–100 mil linhas em
um ou dois anos é plausível — e isso ainda é **pequeno** para Postgres com
esses índices. `notifications` e `campaign_video_captions` crescem em
proporção parecida e também são indexadas.

**O que fazer: nada, por enquanto — e isso é uma decisão, não um
esquecimento.** O que vale monitorar é o **tamanho total do banco contra o
limite do plano do Supabase**, que é o limite que chega antes de qualquer
degradação de desempenho. Quando chegar a hora, arquivar `logs` com mais de
N meses numa tabela fria é meio dia de trabalho.

### 2.9. Redis: AOF e a lição do spam de boot

O Redis roda com `--appendonly yes` e volume próprio. Dois pontos de atenção
documentados em `docs/ERROS_E_APRENDIZADOS.md`:

- **Reenvio no boot.** Jobs antigos ficaram no AOF e foram reentregues a
  cada `docker compose up`, reenviando disparos de dias atrás. As travas de
  atraso (`dispatch-staleness`) já protegem contra isso; ficou pendente
  confirmar se a limpeza do Redis de produção chegou a ser feita — vale
  checar.
- **Crescimento do AOF.** `defaultJobOptions` limpa jobs concluídos em 24 h
  e falhos em 7 dias (`src/queues/bullmq.js`), então a fila em si não cresce
  sem limite. Mas o media-spool guarda mídia de disparo pontual no Redis com
  TTL de 12 horas (`src/services/media-spool.js:57`) — vídeos grandes
  agendados fazem o AOF inchar temporariamente. Com pouco uso de agendamento
  isso é irrelevante; com uso pesado, é uma variável a acompanhar.

**O que fazer:** definir `maxmemory` + política de eviction no Redis (**1
hora**) e incluir o tamanho do AOF na rotina de checagem mensal da Seção 4.

---

## 3. Manutenção que não depende de crescimento nenhum

Os itens da Seção 2 são disparados por volume. Os desta seção vão acontecer
de qualquer jeito, mesmo que o sistema nunca cresça. Somados, são a maior
parte do tempo real de manutenção.

| O que | Por que acontece | Frequência esperada | Esforço por ocorrência |
|---|---|---|---|
| **Sessão do WhatsApp cai** | Baileys/Evolution perdem sessão; o WhatsApp desloga aparelho sozinho | Imprevisível, algumas vezes por ano por número | 15 min a 1 h (reler QR na tela de Configurações) — mas **enquanto está caída, aquele número não envia** |
| **Nome da instância dessincroniza** | Já aconteceu e já tem autocorreção (`resolveInstanceNames`), mas a classe de problema não sumiu | Raro | Minutos, se a autocorreção pegar; horas, se não |
| **Modelo Gemini descontinuado** | Google aposenta modelo e a API devolve 404 | 1 a 2× por ano | Quase zero — a cascata de fallback (`docs/IA_MODELOS.md`) já cobre. Só exige atualizar a configuração com calma |
| **Migration nova** | **Nenhuma migration é aplicada automaticamente** — não há CLI do Supabase linkada. Alguém cola SQL no editor, a cada deploy que traz migration | A cada deploy com mudança de schema | 5 a 15 min, **mas é o passo mais arriscado do deploy**: `docs/ERROS_E_APRENDIZADOS.md` tem dois incidentes graves causados exatamente por migration não aplicada ou aplicada fora de ordem |
| **Deploy** | Processo manual de 7 passos (ver `CLAUDE.md`), com sincronização por SSH, rebuild e verificação de saúde | A cada release | 20 a 40 min, se nada der errado |
| **Suíte de testes** | `npm test` é uma **corrente única de 82 arquivos encadeados com `&&`** em `package.json` | A cada teste novo | O arquivo precisa ser adicionado à corrente na mão, e **uma falha no meio para tudo depois dela**. Trocar por um runner que descobre `tests/*.test.js` sozinho: **2 horas**, e paga em todo teste futuro |
| **Atualização da imagem da Evolution** | A tag é `latest` por padrão (`EVOLUTION_API_IMAGE`) | Quando o projeto upstream quebra ou muda | Horas, e **arrisca a sessão do WhatsApp** — vale fixar uma versão explícita: **15 min** |

O item que mais vale corrigir dessa lista não é o mais frequente, é o mais
perigoso: **migration manual**. Enquanto aplicar SQL depender de alguém
lembrar de colar no lugar certo na ordem certa, o sistema tem um modo de
falha que derruba 100% dos envios (foi exatamente o que aconteceu no
incidente "Coluna nova quebrando 100% dos envios durante a janela de
deploy"). Automatizar isso — CLI do Supabase linkada, ou um passo de
migration no deploy — é **1 a 2 dias** e elimina uma classe inteira de
incidente.

---

## 4. Quem mantém, e quanto tempo isso toma

### Perfil necessário

Não é um time. É **uma pessoa dev com perfil de backend Node** que saiba:

- Node.js e Express (o código é JavaScript puro, sem TypeScript, sem
  framework opinativo — a barreira de entrada é baixa);
- Docker Compose o suficiente para rebuildar, ler log e diagnosticar
  container que não sobe;
- SQL o bastante para aplicar migration e rodar consulta de diagnóstico no
  Supabase;
- o conceito de fila (BullMQ) — que é onde mora a maior parte da lógica de
  negócio.

Não precisa de especialista em WhatsApp, em IA ou em infraestrutura. A
arquitetura em camadas (controller → service → repository, descrita em
`docs/ARQUITETURA.md`) é consistente e os comentários no código explicam o
*porquê* das decisões não óbvias, que é justamente o que costuma faltar.

### Rotina estimada, no volume de hoje

| Atividade | Frequência | Tempo |
|---|---|---|
| Checagem de saúde (containers, Sentry, cobertura de instância, últimas campanhas) | Semanal | 30 min |
| Deploy + migration | A cada release | 30 a 45 min |
| Incidente de sessão de WhatsApp | Algumas vezes por ano | 1 h por ocorrência |
| Investigação de disparo que não saiu | Sob demanda | 1 a 3 h |
| Ajuste de configuração (janela, intervalo, modelo de IA) | Mensal | 15 min |

**Total em regime de cruzeiro: algo entre 4 e 8 horas por mês** — meio dia,
grosso modo. Isso cobre *operar*, não evoluir.

### O que muda com crescimento

O tempo de operação não cresce proporcional ao número de grupos; cresce **em
degraus**, e cada degrau é um item da Seção 2 sendo atingido. A leitura
honesta:

| Cenário | Operação mensal | Trabalho de dev que o cenário exige |
|---|---|---|
| **Até ~300 grupos, 3 números** | 4 a 8 h | Nenhum obrigatório. Vale fazer os itens baratos da Seção 5 |
| **300 a 1.000 grupos, 3 a 5 números** | 8 a 16 h | Seções 2.1, 2.2, 2.3 e 2.4 viram obrigatórias: **2 a 3 semanas de dev**, distribuíveis |
| **Acima de 1.000 grupos, ou vários números novos** | 16 h+ | Some 2.5 e 2.7 (segunda VM, sessão no Redis): **mais 1 a 2 semanas** |

Esses números são de *esforço de implementação*, não de calendário. Uma
pessoa em meio período leva mais.

---

## 5. Por onde começar

Ordenado por **retorno dividido por esforço**, não por gravidade. Os quatro
primeiros somam menos de uma semana e removem os modos de falha
*silenciosos* — que são os caros, porque ninguém percebe até o cliente
perceber.

| # | Ação | Esforço | Por quê agora |
|---|---|---|---|
| 1 | `.limit()` explícito + log em `searchByName` | 1 h | Converte truncamento silencioso em falha visível (2.3) |
| 2 | Aviso de cobertura ao cadastrar número novo | Meio dia | Evita a campanha que "roda com sucesso" e não envia nada (2.4) |
| 3 | `POST /groups/sync` assíncrono na fila existente | Meio dia | O botão vai quebrar antes do sync noturno (2.2) |
| 4 | `mem_limit`/`cpus` nos workers + fixar versão da Evolution | 2 h | Protege a sessão do WhatsApp da vizinhança (2.7, Seção 3) |
| 5 | Runner de teste por descoberta de arquivo | 2 h | Paga em todo teste futuro (Seção 3) |
| 6 | Migration automatizada no deploy | 1 a 2 dias | Elimina a classe de incidente mais grave já registrada (Seção 3) |
| 7 | Sync de grupos em lote | 1 a 2 dias | Antes de ~300 grupos (2.2) |
| 8 | Busca sob demanda nos seletores de grupo | 2 a 3 dias | Antes de ~1.000 grupos (2.3) |
| 9 | Cronograma de disparo por instância | 3 a 5 dias | Só quando números novos precisarem virar vazão real (2.1) |
| 10 | Sessões no Redis | 1 dia | Só quando houver motivo para uma segunda API (2.5) |

---

## 6. O que explicitamente não precisa de manutenção

Igualmente importante, para não gastar tempo onde não dói:

- **Índices do banco.** A cobertura está adequada para os padrões de
  consulta existentes, inclusive nas tabelas que mais crescem.
- **Idempotência de disparo.** O índice único parcial `idx_logs_trio_ativo`
  (migration `202609070002`) fechou a corrida que duplicava envio, e com
  isso **escalar o `dispatch-worker` já é seguro** — `--scale
  dispatch-worker=N` ou concorrência > 1, como registra o comentário em
  `src/services/dispatch-consistency.service.js:138`. Isso é capacidade
  disponível de graça quando precisar.
- **Cascata de modelos de IA.** O fallback automático já cobre
  descontinuação de modelo sem intervenção.
- **Camadas do código.** A disciplina controller → service → repository está
  mantida. Trocar de provedor de IA ou de gateway de WhatsApp é trabalho
  localizado, não reescrita.
- **Retenção de fila.** `removeOnComplete`/`removeOnFail` já limitam o
  crescimento do Redis pelas filas.

---

## Ver também

- `docs/ESTATISTICAS.md` — os números de produção que sustentam os gatilhos deste documento
- `docs/ARQUITETURA.md` — como as peças se encaixam, e os diagramas de fluxo
- `docs/filas.md` — regra de negócio de cada uma das 8 filas
- `docs/ERROS_E_APRENDIZADOS.md` — os incidentes reais que motivam várias das recomendações acima
- `docs/DEPLOY_ORACLE.md` — infraestrutura, limites da VM e processo de deploy
- `docs/IA_MODELOS.md` — modelos, cascata de fallback e custo
