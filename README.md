# estimulo-project

## Visão geral

Este projeto implementa um MVP para organizar campanhas de envio de conteúdos em grupos de WhatsApp. A aplicação combina uma API Node.js, filas BullMQ com Redis, integração com Evolution API, catálogo de vídeos no Google Drive e persistência no Supabase.

O fluxo principal funciona assim: campanhas são cadastradas na API, o worker `campaign-trigger` identifica os grupos elegíveis, escolhe o próximo vídeo de cada grupo conforme a trilha configurada e envia jobs individuais para a fila `dispatch`. O worker `dispatch` executa a entrega pela Evolution API e registra o histórico no banco.

## Ambiente local

### Variáveis de ambiente

Crie o arquivo `.env` a partir do exemplo versionado:

```bash
cp .env.example .env
```

As principais configurações usadas no ambiente local são:

```env
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_USERNAME=default
REDIS_PASSWORD=redis-local
REDIS_DB=0

EVOLUTION_API_URL=http://localhost:8080
EVOLUTION_API_KEY=change-me
EVOLUTION_INSTANCE_NAME=estimulo-mvp
EVOLUTION_API_TIMEOUT_MS=15000
EVOLUTION_API_PORT=8080
EVOLUTION_API_IMAGE=evoapicloud/evolution-api:latest
EVOLUTION_DB_USER=evolution
EVOLUTION_DB_PASSWORD=evolution-local
EVOLUTION_DB_NAME=evolution
EVOLUTION_DB_PORT=5433

SUPABASE_URL=https://SEU_PROJECT_REF.supabase.co
SUPABASE_ANON_KEY=change-me
SUPABASE_SERVICE_ROLE_KEY=change-me
```

A chave `SUPABASE_SERVICE_ROLE_KEY` deve ficar restrita ao backend. Ela não deve ser exposta no frontend, em logs, em screenshots ou em repositórios públicos.

### IA para legendas (Gemini)

A geracao de legenda/transcricao de videos usa exclusivamente o Gemini, via `GeminiAdapter` em `src/services/ai`:

```env
GEMINI_API_KEY=change-me
GEMINI_TRANSCRIPTION_MODEL=gemini-flash-latest
GEMINI_TEXT_MODEL=gemini-flash-latest
```

Para transcrever, o adapter envia ao Gemini **somente o audio** extraido do
video (`src/services/video-audio-extraction.js`, mono/16 kHz/mp3), nunca o video
completo: a transcricao so depende da fala e o audio isolado custa ~32 tokens por
segundo de midia contra ~258 do video, com upload muito menor. A extracao usa o
ffmpeg instalado como dependencia npm (`@ffmpeg-installer/ffmpeg`); use
`FFMPEG_PATH` para apontar outro binario e `TRANSCRIPTION_AUDIO_ONLY=false` para
voltar a enviar o video em caso de emergencia.

Essas variaveis servem apenas como valor inicial (seed). O modelo principal, a
cascata de fallback e os prompts de geracao/revisao de legenda por agente
(transcricao, geracao de legenda, revisao de legenda) sao configurados pela
tela de Configuracoes e persistidos na tabela `settings` (coluna `ai_agents`),
que passa a ser a fonte de verdade assim que o usuario salvar pela UI.

Suba os serviços locais com Docker Compose:

```bash
docker compose --env-file .env -f infra/docker-compose.yml up -d
```

Se voce quiser subir apenas o Redis, sem Evolution API/Postgres:

```bash
docker compose --env-file .env -f infra/docker-compose.yml up -d redis
```

### Abrir o site local

1. Garanta que o Redis esteja rodando.

```bash
docker compose --env-file .env -f infra/docker-compose.yml up -d redis
```

2. Em outro terminal, suba a API:

```bash
npm run api
```

3. Abra o site pela URL servida pela API:

```txt
http://127.0.0.1:3000/app/index.html
```

Paginas uteis:

```txt
http://127.0.0.1:3000/app/grupos.html
http://127.0.0.1:3000/app/organizacoes.html
http://127.0.0.1:3000/app/trilhas.html
```

Evite abrir os arquivos HTML direto pelo explorador ou por Live Server como primeira opcao. As telas chamam endpoints como `/organizations` e `/groups/search`; quando a pagina e servida pela API na porta `3000`, essas chamadas vao para o lugar certo.

O frontend tambem tem fallback para ambiente local: se voce abrir por outro servidor local, como `http://127.0.0.1:5500`, as chamadas conhecidas de API sao redirecionadas para `http://127.0.0.1:3000`. Mesmo assim, a API precisa estar rodando em `3000`.

### Verificar se esta tudo de pe

Com a API rodando:

```bash
curl http://127.0.0.1:3000/health
curl http://127.0.0.1:3000/organizations
curl http://127.0.0.1:3000/groups/search
```

Resultado esperado:

- `/health` retorna `status: "ok"` e `checks.redis.status: "ok"`.
- `/organizations` retorna a lista de organizacoes do Supabase.
- `/groups/search` retorna a lista de grupos.

Se `/health` responder que o Redis esta indisponivel, suba o Redis antes de testar filas, campanhas ou workers. As listagens simples podem funcionar sem Redis, mas os fluxos de fila dependem dele.

### Fallback sem Docker Desktop

Se o Docker Desktop estiver travado ou sem permissao para subir containers, da para rodar Redis pelo Ubuntu/WSL:

```bash
wsl -d Ubuntu -u root -- bash -lc "apt-get update && apt-get install -y redis-server"
wsl -d Ubuntu -u root -- bash -lc "systemctl disable --now redis-server 2>/dev/null || true; systemctl mask redis-server 2>/dev/null || true; service redis-server stop 2>/dev/null || true; pkill -x redis-server 2>/dev/null || true"
wsl -d Ubuntu -u root -- bash -lc "redis-server --daemonize yes --bind 127.0.0.1 --port 6379 --requirepass redis-local --dir /tmp --dbfilename estimulo-redis.rdb"
```

Teste no WSL:

```bash
wsl -d Ubuntu -- bash -lc "redis-cli -h 127.0.0.1 -a redis-local ping"
```

Se a API do Windows nao conseguir enxergar esse Redis do WSL, a alternativa mais simples continua sendo corrigir/subir o Docker Desktop e usar o Compose. Outra opcao e criar um `portproxy` do Windows para o IP do WSL, mas isso exige terminal como Administrador.

### Verificar status

```bash
docker compose --env-file .env -f infra/docker-compose.yml ps
```

### Servidor e workers

Para rodar o sistema em desenvolvimento, mantenha três terminais abertos, um para cada processo:

```bash
npm run queue:campaign-trigger:worker
```

```bash
npm run queue:dispatch:worker
```

```bash
npm run api
```

Esses comandos representam o funcionamento básico da aplicação: a API recebe as requisições HTTP, o worker `campaign-trigger` transforma campanhas em envios individuais e o worker `dispatch` realiza as entregas.

Com a API em execução, o frontend local pode ser acessado em:

```text
http://127.0.0.1:3000/app/index.html
```

Algumas telas úteis:

```text
http://127.0.0.1:3000/app/grupos.html
http://127.0.0.1:3000/app/organizacoes.html
http://127.0.0.1:3000/app/trilhas.html
http://127.0.0.1:3000/app/campanhas.html
```

1. Crie um projeto no Supabase.
2. Copie o URL e as chaves para o arquivo `.env`.
3. Aplique as migrations de `supabase/migrations/` no projeto, em ordem de nome de arquivo.

### Como aplicar as migrations

Com o Supabase CLI, apontando para o projeto correto:
É recomendável abrir o frontend pela própria API na porta `3000`, porque as telas chamam endpoints como `/organizations`, `/groups/search` e `/trilhas`.

### Verificação rápida

Com Redis e API ativos, alguns endpoints ajudam a confirmar se o ambiente está correto:

```bash
curl http://127.0.0.1:3000/health
curl http://127.0.0.1:3000/organizations
curl http://127.0.0.1:3000/groups/search
```

O endpoint `/health` deve retornar `status: "ok"` e informar o estado do Redis. Listagens simples podem funcionar sem Redis, mas campanhas, filas e workers dependem dele.

## Supabase e banco de dados

As migrations ficam em `supabase/migrations`. Elas devem ser aplicadas no projeto Supabase em ordem cronológica, porque migrations mais recentes normalizam a estrutura de trilhas e substituem colunas legadas do catálogo de vídeos.

O comando abaixo não aplica migrations; ele apenas valida se a aplicação consegue acessar o Supabase configurado:

```bash
supabase link --project-ref SEU_PROJECT_REF
supabase db push
```

`supabase/migrations/` é a única fonte de verdade do schema. As migrations são
incrementais e dependentes de ordem: aplicar só a primeira (`202607140001_create_mvp_schema.sql`)
não deixa o banco no estado que a aplicação espera. Depois de aplicar, confirme
a conexão com `npm run db:test`.

O diretório `supabase/.temp/` é cache local do CLI e não deve ser versionado:
ele guarda o project ref e a URL do pooler do banco.

### Como executar o seed
Para popular dados iniciais de desenvolvimento:

```bash
npm run seed
```

O seed cria registros de exemplo de forma idempotente, incluindo organizações, grupos, campanhas, vídeos, progresso e logs.

A documentação do modelo de dados está em `docs/documentacao_banco.md`.

## Testes

Execute a suíte completa com:

```bash
npm test
```

Também é possível rodar testes específicos:

```bash
npm run test:integration
npm run test:repositories
npm run test:api
npm run db:test
```

## Endpoints principais

- `GET /health`: verifica API, Redis, filas e último envio registrado.
- `GET /organizations` e `POST /organizations`: listam e criam organizações.
- `GET /groups/search`: lista grupos cadastrados.
- `PATCH /groups/:id`: atualiza configurações operacionais do grupo.
- `POST /groups/:id/test-dispatch`: dispara um envio de teste para um grupo.
- `GET /campaigns` e `POST /campaigns`: listam e criam campanhas.
- `POST /campaigns/dispatch`: solicita processamento de campanha.
- `POST /campaigns/:id/dispatch/confirm`: confirma a criação dos logs/envios planejados.
- `GET /reports/dispatches`: consulta histórico de disparos.
- `GET /trilhas`, `POST /trilhas`, `PATCH /trilhas/:id` e `DELETE /trilhas/:id`: mantêm as trilhas.
- `POST /trilhas/:id/videos`, `DELETE /trilhas/:id/videos/:videoId` e `POST /trilhas/:id/reorder`: mantêm a ordem dos vídeos por trilha.
- `POST /video-catalog/transcript` e `POST /video-catalog/:id/transcript`: geram ou atualizam transcrições.

## Encerramento

Para interromper os serviços locais:

```bash
docker compose --env-file .env -f infra/docker-compose.yml down
```

Para remover também os volumes locais:

```bash
docker compose --env-file .env -f infra/docker-compose.yml down -v
```

- `POST /campaigns`: cria campanhas usando o serviço existente.
- `GET /health`: devolve status geral do sistema, Redis, fila BullMQ e último dispatch.

## Processos em produção

A API não executa fila nenhuma. Cada worker é um processo separado e todos
precisam estar de pé, além do Redis:

| Processo | Comando | Papel |
| --- | --- | --- |
| API | `npm run api` | HTTP + frontend estático em `/app` |
| Campaign trigger | `npm run queue:campaign-trigger:worker` | Agenda e dispara campanhas recorrentes |
| Dispatch | `npm run queue:dispatch:worker` | Envio de vídeo/legenda para os grupos |
| Dispatch review timeout | `npm run queue:dispatch-review-timeout:worker` | Expira revisões de legenda pendentes |
| Dispatch failure retry | `npm run queue:dispatch-failure-retry:worker` | Reprocessa envios que falharam |
| Mensagens (disparo pontual) | `npm run queue:mensagens-dispatch:worker` | Fila da tela "Disparador Pontual" |
| Group sync | `npm run queue:group-sync:worker` | Sincroniza grupos e contagem de membros |
| Drive video index | `npm run queue:drive-video-index:worker` | Indexa e transcreve vídeos do Google Drive |

Sem o worker de `mensagens-dispatch`, a tela de Disparador Pontual enfileira o
envio e nada acontece.
Mais detalhes estão em `docs/filas.md`, `docs/evolution-api.md`, `docs/estrutura.md` e `docs/documentacao_banco.md`.
