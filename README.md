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

### Provedor de IA para legendas

A geracao de legenda/transcricao de videos usa um adapter configuravel. Defina o provedor em `AI_PROVIDER` para alternar entre Gemini e GPT/OpenAI sem alterar codigo ou fazer novo deploy:

```env
AI_PROVIDER=gemini
GEMINI_API_KEY=change-me
GEMINI_TRANSCRIPTION_MODEL=gemini-flash-latest
GEMINI_TEXT_MODEL=gemini-flash-latest

# ou
AI_PROVIDER=gpt
OPENAI_API_KEY=change-me
OPENAI_TRANSCRIPTION_MODEL=gpt-4o-mini-transcribe
OPENAI_TRANSCRIPTION_LANGUAGE=pt
```

Valores aceitos: `gemini`, `openai` ou `gpt`. Os adapters disponiveis ficam em `src/services/ai`: `GeminiAdapter` e `OpenAIAdapter`.

### Iniciar ambiente local

```bash
docker compose --env-file .env -f infra/docker-compose.yml up -d
```

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
3. Execute a migration contida em `supabase/migrations/202607140001_create_mvp_schema.sql` no SQL Editor do Supabase, na mesma instância do projeto.

### Como executar a migration

```bash
npm run db:test
```

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
