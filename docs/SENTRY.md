# Sentry (rastreamento de erros)

Captura, em um so lugar, o erro exato (mensagem + stack trace) que a API, os
workers e o painel (frontend) produzem em producao - incluindo, no painel, um
**Session Replay**: uma reconstrucao da tela (DOM, sem audio/video) dos passos
que o usuario deu ate o erro aparecer. Resolve o problema de "o usuario
detectou um erro mas nao sabe descrever o que fez": o replay mostra
exatamente isso.

Sem `SENTRY_DSN` configurado, tudo fica desligado (API, workers e painel) -
nao ha nenhuma chamada de rede nem custo. E' seguro fazer deploy deste projeto
sem nunca configurar o Sentry.

## O que esta instrumentado

- **API** (`scripts/start-api.js` / `src/api/app.js`): toda excecao nao
  tratada por um controller (5xx, ou sem status - ver
  `estimuloEhErroDeServidor` no painel), alem de `uncaughtException` e
  `unhandledRejection` do processo.
- **Workers BullMQ** (`scripts/start-*-worker.js`): erro de conexao das
  filas/Redis e falha de job apos esgotar as tentativas (`src/queues/bullmq.js`),
  capturados para todas as filas automaticamente.
- **Painel** (`public/app/assets/js/sentry-init.js`): erro de JS nao tratado,
  breadcrumbs automaticos (clique, `fetch`, console, navegacao) e Session
  Replay. Tambem captura os erros que o painel mostra na caixa "Ops... algo
  inesperado aconteceu" quando sao de servidor (nao quando sao apenas um campo
  invalido do formulario).

## Configurar

1. Crie uma conta gratuita em https://sentry.io e um projeto (plataforma
   "Node.js" ou "Browser JavaScript" - tanto faz, o mesmo projeto recebe
   eventos dos dois SDKs, cada um marcado com a tag `platform`).
2. Copie o DSN do projeto (Settings → Projects → *seu projeto* → Client Keys (DSN)).
3. Cole no `.env`:

   ```env
   SENTRY_DSN=https://...@o.....ingest.sentry.io/...
   ```

4. Reinicie a API (`npm run api`) e os workers que estiverem rodando. O
   painel busca a config em `GET /config/sentry` a cada carregamento de
   pagina, entao nao precisa de rebuild - so recarregar a pagina depois do
   backend reiniciado.

Variaveis opcionais (todas em `.env.example`, com o default ja aplicado se
deixar em branco):

- `SENTRY_ENVIRONMENT`: rotulo do ambiente no Sentry (filtro "Environment").
  Vazio usa `NODE_ENV`.
- `SENTRY_TRACES_SAMPLE_RATE` (0-1, default `0`): fracao de requisicoes com
  tracing de performance. Deixe `0` se so quer erro/replay - performance usa
  uma cota separada do plano.
- `SENTRY_REPLAYS_SESSION_SAMPLE_RATE` (0-1, default `0`): fracao de sessoes
  **normais** (sem erro) gravadas.
- `SENTRY_REPLAYS_ON_ERROR_SAMPLE_RATE` (0-1, default `1`): fracao das sessoes
  **com erro** que ganham replay. E' este valor, em 1 (100%), que resolve o
  problema original.

O plano gratuito do Sentry cobre um volume mensal de erros, replays e
"performance units" - com os defaults acima (replay so em sessao com erro,
tracing desligado) o consumo fica bem abaixo do teto para o uso deste painel.

## Onde ver os erros capturados

Depois de configurado, entre em https://sentry.io, abra o projeto e:

- **Issues** (menu lateral): lista cada erro agrupado por assinatura (mesma
  causa = mesmo grupo, com contador de quantas vezes aconteceu e para quantos
  usuarios). Abrindo um item: mensagem, stack trace, breadcrumbs (o que o
  usuario fez antes - clique, requisicao, navegacao) e, se veio do painel, o
  botao **Replay** com a gravacao da tela daquela sessao.
- **Replays** (menu lateral): lista todas as gravacoes, mesmo sem abrir a
  partir de um erro especifico.
- O usuario que sofreu o erro aparece no evento (`estimuloSentrySetUser` em
  `nav.js` manda o `username` da sessao logada) e tambem qual pagina/rota da
  API.
- De onde veio (`tags.event`, `tags.queue`, `serverName`) diz se a falha foi
  na API, em qual worker/fila, ou no navegador.

## Arquivos

- `src/config/sentry.js` - inicializacao do SDK Node (`initSentry`), usada por
  `scripts/start-api.js` e por todo `scripts/start-*-worker.js`.
- `src/queues/bullmq.js` - captura generica de erro de fila/job para todas as
  filas.
- `GET /config/sentry` (`src/api/app.js`) - unica rota publica (nao exige
  login) que expõe o DSN e as taxas de amostragem para o navegador. DSN nao e'
  segredo: e' feito para ser embutido em codigo cliente.
- `public/app/assets/js/sentry-init.js` - inicializacao do SDK Browser, mais
  os helpers `window.estimuloCaptureError` e `window.estimuloSentrySetUser`
  usados por `nav.js`.
