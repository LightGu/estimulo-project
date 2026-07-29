# estimulo-project

## Ambiente local

O ambiente de desenvolvimento usa Docker Compose para subir uma instancia local do Redis, usada como infraestrutura de filas da aplicacao com BullMQ, e uma instancia local da Evolution API para testes controlados de integracao com WhatsApp durante o MVP.

### Variaveis de ambiente

Crie o arquivo `.env` a partir do exemplo versionado:

```bash
cp .env.example .env
```

As configuracoes de conexao ficam centralizadas nas variaveis:

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
```

Na aplicacao Node.js, use `src/config/redis.js` como ponto unico de leitura dessas configuracoes para criar conexoes do BullMQ/ioredis.
Os helpers de `src/queues/bullmq.js` devem ser usados para criar `Queue`, `Worker` e `QueueEvents` com a conexao Redis compartilhada.
Para entregas no WhatsApp, use `src/services/evolution.js`; nenhuma outra parte da aplicacao deve chamar a Evolution API diretamente.

Mais detalhes e exemplos estao em `docs/filas.md` e `docs/evolution-api.md`.

### IA para legendas (Gemini)

A geracao de legenda/transcricao de videos usa exclusivamente o Gemini, via `GeminiAdapter` em `src/services/ai`:

```env
GEMINI_API_KEY=change-me
GEMINI_TRANSCRIPTION_MODEL=gemini-flash-latest
GEMINI_TEXT_MODEL=gemini-flash-latest
```

Essas variaveis servem apenas como valor inicial (seed). O modelo principal, a
cascata de fallback e os prompts de geracao/revisao de legenda por agente
(transcricao, geracao de legenda, revisao de legenda) sao configurados pela
tela de Configuracoes e persistidos na tabela `settings` (coluna `ai_agents`),
que passa a ser a fonte de verdade assim que o usuario salvar pela UI.

### Iniciar ambiente local

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

### Interromper ambiente

```bash
docker compose --env-file .env -f infra/docker-compose.yml down
```

Para remover tambem os dados persistidos no volume local do Redis:

```bash
docker compose --env-file .env -f infra/docker-compose.yml down -v
```

## Supabase e banco de dados

Preencha as variaveis do arquivo `.env` com o URL do projeto Supabase e as chaves apropriadas para o ambiente backend:

```env
SUPABASE_URL=https://SEU_PROJECT_REF.supabase.co
SUPABASE_ANON_KEY=change-me
SUPABASE_SERVICE_ROLE_KEY=change-me
```

A service role key deve ser usada apenas no backend. Nunca exponha `SUPABASE_SERVICE_ROLE_KEY` no frontend, em logs, em screenshots ou em repositórios públicos.

### Como configurar o Supabase

1. Crie um projeto no Supabase.
2. Copie o URL e as chaves para o arquivo `.env`.
3. Aplique as migrations de `supabase/migrations/` no projeto, em ordem de nome de arquivo.

### Como aplicar as migrations

Com o Supabase CLI, apontando para o projeto correto:

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

```bash
npm run seed
```

O seed cria de forma idempotente uma organização, três grupos, duas campanhas, associações, dez vídeos, progresso e logs de exemplo.

### Como testar a conexão

```bash
npm run db:test
```

A verificacao considera uma tabela vazia como sucesso de conexao, mas exige que as variaveis do `.env` estejam preenchidas corretamente e que a migration tenha sido aplicada no projeto alvo.

### Como rodar os testes

```bash
npm test
npm run test:integration
npm run test:repositories
npm run test:api
npm run db:test
```

### Endpoints HTTP

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
