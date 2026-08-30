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
EVOLUTION_API_TIMEOUT_MS=15000
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
- `EVOLUTION_API_TIMEOUT_MS`: tempo maximo, em milissegundos, para a aplicacao aguardar resposta da Evolution API.
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

## Gerenciamento de instancias (multiplos numeros)

O wrapper `src/services/evolution-instances.js` centraliza as chamadas de gerenciamento de
instancia usadas pela tela de Configuracoes para conectar/remover numeros de WhatsApp:

- `POST /instance/create` - cria uma nova instancia (`{instanceName, qrcode: true, integration: "WHATSAPP-BAILEYS"}`).
- `GET /instance/connect/:instance` - retorna o QR Code para conectar a instancia.
- `GET /instance/connectionState/:instance` - consulta o estado da conexao.
- `DELETE /instance/logout/:instance` seguido de `DELETE /instance/delete/:instance` - desconecta e remove a instancia.
- `GET /instance/fetchInstances` - lista instancias existentes.

**Importante:** os nomes exatos dos campos retornados por `/instance/connect/:instance` (QR code)
e `/instance/connectionState/:instance` (enum de estado) devem ser confirmados com uma chamada
`curl` real contra o container em execucao antes de assumir o formato em codigo de producao -
os nomes usados em `evolution-instances.js` (`data.base64`, `data.instance.state`) sao a
suposicao inicial baseada na documentacao publica da Evolution API v2 e podem variar conforme a
versao da imagem `evoapicloud/evolution-api`.

## Uso pela aplicacao

O codigo da aplicacao nao deve chamar a Evolution API diretamente. Toda entrega para WhatsApp deve passar pelo wrapper `src/services/evolution.js`, que centraliza autenticacao, montagem do payload, escolha do endpoint e tratamento basico de erros.

Exemplo para texto:

```js
const { sendToEvolution } = require("../services/evolution");

await sendToEvolution({
  groupId: "120363000000000000@g.us",
  message: "Mensagem de teste do MVP",
});
```

Exemplo para conteudo com legenda:

```js
await sendToEvolution({
  groupId: "120363000000000000@g.us",
  message: "Material da trilha",
  content: {
    url: "https://example.com/material.pdf",
    fileName: "material.pdf",
    mimeType: "application/pdf",
    type: "document",
  },
});
```

Tambem e possivel enviar um arquivo local informando `content.filePath`. Nesse caso, o wrapper converte o arquivo para base64 antes do envio.

## Confirmacao de entrega (por que "enviado" nao era "enviado")

A resposta HTTP de `POST /message/sendMedia` e `POST /message/sendText` significa
apenas que a Evolution **aceitou** a mensagem. Ela devolve `data.key.id` e
`data.status: "PENDING"`, grava a mensagem no banco dela e so troca esse status
quando o WhatsApp confirma o recebimento:

```text
PENDING -> SERVER_ACK -> DELIVERY_ACK -> READ (ou PLAYED)
```

Enquanto a aplicacao marcava o log como `enviado` so por a chamada HTTP ter dado
200, aceite e entrega ficavam indistinguiveis no relatorio - e foi assim que
campanhas apareceram como entregues sem ninguem ter recebido nada.

### O ACK nao existe para mensagem enviada a grupo

Isso limita o alcance da confirmacao, e a limitacao e estrutural. Medido na
instancia real (04/08/2026):

| Populacao | Resultado |
| --- | --- |
| 18 mensagens enviadas pela API a grupo (`source='web'`, 11 video + 7 texto) | **todas** em `PENDING`, nenhuma com linha em `MessageUpdate` |
| 352 linhas de ACK em `MessageUpdate` (270 `DELIVERY_ACK`, 82 `READ`, 10 `PLAYED`) | **todas** de `remoteJid` fora de grupo |

Ou seja: `PENDING` numa mensagem de grupo nao quer dizer nada. Nao e "nao chegou",
e "nao existe ACK para consultar". O WhatsApp entrega recibo por participante em
grupo, e o Baileys/Evolution nao converte isso em `Message.status`.

A consequencia pratica de ignorar isso foi tratar a falta de ACK como falha: os
disparos de campanha - que sao todos para grupo - eram reprovados em bloco. Video
que chegou ao grupo aparecia como "Falhou", cada log gerava notificacao de falha
no WhatsApp e o sweep de `dispatch-failure-retry` estava livre para reenviar o
mesmo video. Trocar "entregue sem lastro" por "falhou com a mensagem no grupo" nao
resolvia nada; so invertia o lado da mentira.

Se a Evolution passar a gravar ACK de grupo, nada precisa mudar: o ACK confirmado
e reconhecido em qualquer destino, e o selo vira "Confirmado" automaticamente.

### De onde vem o ACK

Na v2.3.7 nao da para ler esse estado pela API: `POST /chat/findMessages` nao
inclui `Message.status` no `select` do Prisma, e a relacao `MessageUpdate` volta
vazia mesmo para mensagens de grupo que ja chegaram a `READ` (verificado contra a
instancia real). O unico caminho confiavel e consultar o Postgres da propria
Evolution:

```sql
SELECT status FROM "Message" WHERE "key"->>'id' = '<provider_message_id>';
```

E o que `src/services/evolution-message-status.js` faz, usando as variaveis
`EVOLUTION_DB_*` (ou `EVOLUTION_DB_URL`). Para conferir a mao qual foi o destino
de cada envio de um dia:

```bash
docker exec estimulo-evolution-postgres psql -U evolution -d evolution -c \
  "SELECT to_timestamp(m.\"messageTimestamp\") AT TIME ZONE 'America/Sao_Paulo' AS ts,
          m.\"key\"->>'remoteJid' AS jid, m.status
     FROM \"Message\" m
    WHERE m.\"key\"->>'fromMe' = 'true'
    ORDER BY m.\"messageTimestamp\" DESC LIMIT 20;"
```

Numa conversa fora de grupo, uma sequencia de `PENDING` significa que a sessao do
WhatsApp aceitou as mensagens mas nao esta entregando - reconecte o numero em
Configuracoes > WhatsApp. Em grupo, `PENDING` e o estado normal e permanente (ver
a secao acima): nao serve como diagnostico.

Para separar as duas populacoes de uma vez:

```bash
docker exec estimulo-evolution-postgres psql -U evolution -d evolution -c \
  "SELECT u.\"fromMe\", (u.\"remoteJid\" LIKE '%@g.us') AS is_group, u.status, count(*)
     FROM \"MessageUpdate\" u GROUP BY 1,2,3 ORDER BY 4 DESC;"
```

### Como o envio usa isso

Depois do aceite, `confirmProviderDelivery` (em
`src/services/delivery-confirmation.js`) consulta o ACK a cada
`DELIVERY_CONFIRMATION_POLL_INTERVAL_MS`, ate
`DELIVERY_CONFIRMATION_TIMEOUT_MS` fora de grupo e ate
`DELIVERY_CONFIRMATION_GROUP_TIMEOUT_MS` em grupo (janela curta: nao ha ACK para
esperar, so vale dar tempo de a Evolution persistir a mensagem e de um ACK de erro
aparecer). O resultado decide o log:

| Situacao | Log | Status no relatorio | Selo de confirmacao |
| --- | --- | --- | --- |
| ACK em SERVER_ACK/DELIVERY_ACK/READ/PLAYED | `enviado` | "Enviado" | "Confirmado" (verde) |
| Grupo, sem ACK ate o prazo | `enviado` com `provider_status=SEM_ACK_DE_GRUPO` | "Enviado" | "Sem ACK (grupo)" (neutro) |
| Fora de grupo, PENDING ate o prazo | `falhou` | "Falhou", com o motivo na dica | — |
| Provedor devolve ERROR/SERVER_ERROR | `falhou` | "Falhou" | — |
| Nao foi possivel consultar o ACK | `enviado` com `provider_status=NAO_VERIFICADO` | "Enviado" | "Nao verificado" (ambar) |

Status e confirmacao sao duas colunas porque respondem perguntas diferentes - "o
envio saiu?" e "alguem confirmou o recebimento?". Enquanto dividiam a mesma
celula, "enviado sem ACK" tinha de ser pintado como entrega ou como problema, e
nenhuma das duas leituras era verdade em grupo.

As linhas de `SEM_ACK_DE_GRUPO` e `NAO_VERIFICADO` sao propositais: nem a ausencia
de um sinal que nao existe (grupo) nem uma falha de infraestrutura nossa (banco da
Evolution inalcancavel, driver ausente, `DELIVERY_CONFIRMATION_ENABLED=false`)
podem reprovar um envio que provavelmente deu certo - mas tambem nao podem ser
vendidas como entrega confirmada.

`dispatch-failure-retry` trata "nao confirmou a entrega" como falha **permanente**:
nesse caso a mensagem ja saiu e a midia ja subiu, entao reenviar duplicaria o
conteudo no grupo sem chance de mudar o ACK. Isso tambem protege os logs
falso-negativo gravados antes desta correcao.

## Disparo pontual e campanha de video rodam em filas independentes

`mensagens-dispatch` (disparo pontual) e a fila de disparo de campanha de video
sao filas separadas e nao se bloqueiam entre si: um disparo pontual pode
acontecer entremeado com uma campanha de video em andamento normalmente.

O que continua proibido (`src/services/campaign-window-conflict.js`,
`assertNoCampaignWindowConflict`) e duas campanhas **do mesmo tipo** (pontual
x pontual, ou video x video) disputarem os **mesmos grupos** na **mesma
janela**: as duas resolveriam o "proximo envio" daquele grupo na mesma fila e
uma atropelaria a outra. Pontual x campanha de video nos mesmos grupos e
janela e permitido, mesmo com grupos identicos - cada tipo roda na sua propria
fila (`mensagens-dispatch` ou `dispatch`) e resolve seu proprio "proximo" sem
disputa. Janelas que se cruzam para grupos diferentes tambem sao sempre
permitidas, independente do tipo.

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
