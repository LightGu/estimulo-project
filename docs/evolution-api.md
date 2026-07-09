# Evolution API para testes de WhatsApp

Este ambiente sobe uma instancia local da Evolution API via Docker Compose para validar, durante o MVP, conexao com WhatsApp, autenticacao, envio de mensagens e retorno de status.

Use esta instancia apenas para testes controlados de integracao.

## Variaveis de ambiente

Crie o arquivo `.env` a partir do exemplo versionado:

```bash
cp .env.example .env
```

Configure as variaveis abaixo antes de subir o ambiente:

```env
EVOLUTION_API_URL=http://localhost:8080
EVOLUTION_API_KEY=change-me
EVOLUTION_INSTANCE_NAME=estimulo-mvp
EVOLUTION_API_PORT=8080
EVOLUTION_API_IMAGE=evoapicloud/evolution-api:latest
EVOLUTION_DB_USER=evolution
EVOLUTION_DB_PASSWORD=evolution-local
EVOLUTION_DB_NAME=evolution
EVOLUTION_DB_PORT=5433
```

- `EVOLUTION_API_URL`: URL publica/local usada pela Evolution API para montar retornos e webhooks.
- `EVOLUTION_API_KEY`: chave global de autenticacao da API. Troque o valor padrao antes de compartilhar o ambiente.
- `EVOLUTION_INSTANCE_NAME`: nome da instancia de WhatsApp usada nos testes.
- `EVOLUTION_API_PORT`: porta exposta no host local.
- `EVOLUTION_API_IMAGE`: imagem Docker da Evolution API usada pelo Compose.
- `EVOLUTION_DB_USER`, `EVOLUTION_DB_PASSWORD`, `EVOLUTION_DB_NAME`: credenciais do PostgreSQL local usado pela Evolution API.
- `EVOLUTION_DB_PORT`: porta do PostgreSQL exposta no host local. Dentro do Compose, a API usa `evolution-postgres:5432`.

O servico usa PostgreSQL local para persistencia da Evolution API e o Redis local do Compose como cache interno. A aplicacao Node.js continua usando as variaveis `REDIS_*` documentadas em `docs/filas.md`.

## Subir a instancia

Na raiz do projeto, execute:

```bash
docker compose --env-file .env -f infra/docker-compose.yml up -d
```

Verifique se os containers estao em execucao:

```bash
docker compose --env-file .env -f infra/docker-compose.yml ps
```

A API ficara disponivel em:

```text
http://localhost:8080
```

Se `EVOLUTION_API_PORT` for alterada, use a porta configurada.

## Validar autenticacao

Use a chave configurada em `EVOLUTION_API_KEY` no header `apikey`:

```bash
curl -H "apikey: change-me" http://localhost:8080/instance/fetchInstances
```

Uma resposta HTTP autorizada confirma que a API esta acessivel e aceitando a chave configurada.

## Criar instancia de teste

Crie a instancia informando o nome configurado em `EVOLUTION_INSTANCE_NAME`:

```bash
curl -X POST http://localhost:8080/instance/create \
  -H "Content-Type: application/json" \
  -H "apikey: change-me" \
  -d '{"instanceName":"estimulo-mvp","qrcode":true,"integration":"WHATSAPP-BAILEYS"}'
```

Depois, consulte as instancias:

```bash
curl -H "apikey: change-me" http://localhost:8080/instance/fetchInstances
```

Use o QR Code retornado pela API para conectar uma conta de WhatsApp destinada a testes.

## Enviar mensagem de teste

Apos a instancia estar conectada, envie uma mensagem para um numero controlado:

```bash
curl -X POST http://localhost:8080/message/sendText/estimulo-mvp \
  -H "Content-Type: application/json" \
  -H "apikey: change-me" \
  -d '{"number":"5511999999999","text":"Mensagem de teste do MVP"}'
```

Substitua `5511999999999` por um numero autorizado para teste.

## Ver logs e encerrar

Logs da Evolution API:

```bash
docker logs estimulo-evolution-api
```

Encerrar os servicos:

```bash
docker compose --env-file .env -f infra/docker-compose.yml down
```

Remover tambem os volumes locais, incluindo sessoes e instancias salvas:

```bash
docker compose --env-file .env -f infra/docker-compose.yml down -v
```

## Referencias

- Documentacao Docker da Evolution API v2: https://doc.evolution-api.com/v2/en/install/docker
- Variaveis de ambiente da Evolution API v2: https://doc.evolution-api.com/v2/en/env
- Repositorio atual da Evolution API: https://github.com/evolution-foundation/evolution-api
