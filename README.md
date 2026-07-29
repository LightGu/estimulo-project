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

### Provedor de IA

A geração de transcrição e legendas usa um adapter configurável. Defina `AI_PROVIDER` para alternar entre Gemini e GPT/OpenAI:

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

Valores aceitos: `gemini`, `openai` ou `gpt`. Os adapters ficam em `src/services/ai`.

## Como executar

### Infraestrutura

Suba os serviços locais com Docker Compose:

```bash
docker compose --env-file .env -f infra/docker-compose.yml up -d
```

Quando for necessário apenas o Redis, por exemplo para desenvolver a API e os workers sem a Evolution API local, use:

```bash
docker compose --env-file .env -f infra/docker-compose.yml up -d redis
```

Verifique os containers:

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
npm run db:test
```

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

Mais detalhes estão em `docs/filas.md`, `docs/evolution-api.md`, `docs/estrutura.md` e `docs/documentacao_banco.md`.
