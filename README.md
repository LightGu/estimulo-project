# estimulo-project

## Ambiente local

O ambiente de desenvolvimento usa Docker Compose para subir uma instancia local do Redis, usada como infraestrutura de filas da aplicacao com BullMQ.

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
```

Na aplicacao Node.js, use `src/config/redis.js` como ponto unico de leitura dessas configuracoes para criar conexoes do BullMQ/ioredis.
Os helpers de `src/queues/bullmq.js` devem ser usados para criar `Queue`, `Worker` e `QueueEvents` com a conexao Redis compartilhada.

Mais detalhes e exemplos estao em `docs/filas.md`.

### Iniciar Redis

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
