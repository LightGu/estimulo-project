# Deploy da API na Oracle Cloud (Ubuntu 20.04)

Este guia sobe somente o backend deste repositorio na VM. O banco da aplicacao e o Supabase externo; Redis e obrigatorio e fica interno ao Docker. A Evolution API e opcional no mesmo host porque ela exige tambem um PostgreSQL e consome memoria significativa.

## Antes de comecar

- Confirme a RAM da sua VM antes de ativar o perfil `workers`/`evolution` (`free -h` na VM). Em shapes pequenos (ex.: 1 GB), API + sete workers + Evolution + PostgreSQL podem exceder a capacidade sob carga - prefira hospedar a Evolution em outro host ou aumente a VM antes de ativar o perfil `evolution`.
- Para login por frontend Vercel em dominio diferente, a API precisa de HTTPS e de um dominio proprio. Cookies `SameSite=None` e o cookie `Secure` (obrigatorio quando `NODE_ENV=production`) nao funcionam em HTTP. Para testar login direto por IP em HTTP antes de configurar dominio/TLS, defina `ESTIMULO_COOKIE_SECURE=false` no `.env` - volte a remover essa variavel (ou defina `true`) assim que houver HTTPS.
- O compose nao publica Redis (6379), PostgreSQL da Evolution (5432) nem Evolution (8080).

## 1. Instalar Docker

Os comandos oficiais atuais do Docker usam o repositorio APT. O Ubuntu 20.04 (Focal) ja nao aparece na matriz de versoes oficialmente suportadas pela documentacao atual. Atualize a VM para uma LTS suportada antes do deploy de producao, ou valide cuidadosamente os pacotes disponiveis para Focal.

```bash
sudo apt update
sudo apt install -y ca-certificates curl git
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
sudo tee /etc/apt/sources.list.d/docker.sources >/dev/null <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"
newgrp docker
docker run --rm hello-world
docker compose version
```

Se o `apt install` nao encontrar pacotes para Focal, nao use o script `get.docker.com` em producao. Atualize o Ubuntu primeiro para uma LTS suportada e repita os comandos.

## 2. Copiar o projeto

Com Git e acesso autorizado ao repositorio:

```bash
git clone https://github.com/LightGu/estimulo-project.git
cd estimulo-project
```

Ou copie a pasta pelo seu metodo SSH/SCP habitual e entre nela. Nunca versione nem copie o `.env` para repositorios publicos.

## 3. Configurar o ambiente

```bash
cp .env.example .env
chmod 600 .env
nano .env
```

Preencha obrigatoriamente `REDIS_PASSWORD`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `EVOLUTION_API_URL` e `EVOLUTION_API_KEY`. Preencha Google Drive/Gemini apenas se esses recursos forem usados.

### Credenciais do Google Drive

O JSON da conta de servico **nao entra na imagem** (`credentials/` esta no
`.dockerignore`). Ele chega ao container por bind mount read-only, ja declarado
no `infra/docker-compose.yml`:

```yaml
volumes:
  - ../credentials:/app/credentials:ro
```

Por isso o arquivo precisa existir **no host**, dentro de `credentials/`, antes
do `docker compose up`, e `GOOGLE_DRIVE_CREDENTIALS` deve apontar para o caminho
relativo correspondente:

```bash
mkdir -p credentials
# copie o JSON da conta de servico para credentials/
chmod 600 credentials/*.json
```

```env
GOOGLE_DRIVE_CREDENTIALS=./credentials/SEU-ARQUIVO.json
```

Se o diretorio estiver vazio, o bind mount ainda sobe (o Docker cria a pasta),
mas toda chamada ao Drive falha com `Arquivo de credenciais nao encontrado` -
indexacao de video, testar conexao e reindexar. Alternativa sem arquivo: colar o
JSON inteiro em `GOOGLE_DRIVE_CREDENTIALS`; o codigo aceita as duas formas
(`src/services/google-drive.js` testa se o valor comeca com `{`).

Para frontend Vercel, use a URL final exata, sem `/` no fim:

```env
NODE_ENV=production
PORT=3000
TZ=America/Sao_Paulo
REDIS_PASSWORD=COLOQUE_UMA_SENHA_FORTE_AQUI
SUPABASE_URL=https://SEU_PROJECT_REF.supabase.co
SUPABASE_SERVICE_ROLE_KEY=COLE_A_SERVICE_ROLE_KEY
EVOLUTION_API_URL=https://URL_DA_EVOLUTION_EXTERNA
EVOLUTION_API_KEY=COLE_A_CHAVE_DA_EVOLUTION
CORS_ALLOWED_ORIGINS=https://SEU-PROJETO.vercel.app
ESTIMULO_COOKIE_SAME_SITE=None
```

`ESTIMULO_COOKIE_SAME_SITE=None` exige HTTPS na URL da API. Quando houver dominio/TLS, aponte o frontend para `https://api.seu-dominio.com`, mantenha a URL Vercel em `CORS_ALLOWED_ORIGINS` e configure `EXPRESS_TRUST_PROXY=1` se houver proxy reverso. `http://163.176.107.172:3000` serve apenas para testar `/health`.

Se a Evolution ficar **nesta VM**, configure:

```env
EVOLUTION_API_URL=http://evolution-api:8080
EVOLUTION_DB_HOST=evolution-postgres
EVOLUTION_DB_PORT=5432
EVOLUTION_DB_USER=COLOQUE_USUARIO_LOCAL
EVOLUTION_DB_PASSWORD=COLOQUE_SENHA_FORTE_LOCAL
EVOLUTION_DB_NAME=evolution
EVOLUTION_PUBLIC_URL=https://URL_PUBLICA_DA_EVOLUTION_SE_HOUVER
```

## 4. Iniciar e operar

Somente API + Redis (bom primeiro teste):

```bash
docker compose --env-file .env -f infra/docker-compose.yml up -d --build
```

API + Redis + todos os workers BullMQ:

```bash
docker compose --env-file .env -f infra/docker-compose.yml --profile workers up -d --build
```

Somente se Evolution e seu PostgreSQL tambem ficarem nesta VM (alto consumo para 1 GB):

```bash
docker compose --env-file .env -f infra/docker-compose.yml --profile workers --profile evolution up -d --build
```

Verificacao e logs:

```bash
docker compose --env-file .env -f infra/docker-compose.yml ps
docker compose --env-file .env -f infra/docker-compose.yml logs -f api
docker compose --env-file .env -f infra/docker-compose.yml logs -f dispatch-worker
curl -i http://127.0.0.1:3000/health
curl -i http://163.176.107.172:3000/health
```

Reiniciar:

```bash
docker compose --env-file .env -f infra/docker-compose.yml restart
```

## 4.1. HTTPS sem dominio proprio

Acessar so por IP em HTTP (sem TLS) costuma ser bloqueado por firewall/proxy
corporativo (categoria "desconhecida" por nao ter dominio nem certificado) e
sempre mostra "Nao seguro" no navegador. Sem comprar dominio, resolve com um
host gratuito que resolve para o IP da VM, tipo `sslip.io` (troque os pontos
do IP por hifen): para `163.176.107.172`, o host e' `163-176-107-172.sslip.io`.

Isso nao e garantido contra todo filtro corporativo - alguns bloqueiam esses
hosts de "wildcard DNS" tambem, por serem usados historicamente para burlar
bloqueio por dominio. Se persistir bloqueado, o caminho mais confiavel e' um
dominio de verdade (mesmo o mais barato de um registrador resolve isso melhor).

Passo a passo com o perfil `proxy` (roda o Caddy, que emite/renova o
certificado Let's Encrypt automaticamente):

```env
# no .env
ESTIMULO_PUBLIC_HOSTNAME=163-176-107-172.sslip.io
ESTIMULO_COOKIE_SECURE=true
EXPRESS_TRUST_PROXY=1
```

```bash
docker compose --env-file .env -f infra/docker-compose.yml --profile workers --profile proxy up -d --build
```

Libere as portas 80 e 443 na Security List/NSG (mesmo passo da secao de rede
abaixo, so que para essas portas). Depois teste:

```bash
curl -i https://163-176-107-172.sslip.io/health
```

Se `ESTIMULO_COOKIE_SECURE` continuar em `false` (do teste por IP puro em
HTTP), o cookie de sessao nao vai ser aceito em HTTPS por SameSite/Secure
incoerentes - sempre volte para `true` (ou remova a variavel) ao ligar o Caddy.

Atualizar (use os mesmos perfis escolhidos no deploy):

Se a VM foi provisionada com `git clone` (secao 2), `git pull --ff-only` funciona direto nela. **A VM em producao atual (163.176.107.172) nao e um checkout git** - foi copiada pelo `codex`/sessoes anteriores via `rsync`, entao `git pull` la falha com `not a git repository`. Para essa VM (ou qualquer outra copiada do mesmo jeito), sincronize a partir de uma maquina com a chave SSH e o repositorio local atualizado:

```bash
rsync -avz --delete \
  --exclude ".git" --exclude "node_modules" --exclude ".tmp_preview" \
  --exclude "coverage" --exclude "logs" --exclude ".env" --exclude ".env.*" \
  --exclude "storage/*" --exclude "credentials" \
  -e "ssh -i /caminho/da/chave.key" \
  ./ ubuntu@163.176.107.172:~/estimulo-project/
```

Depois, em qualquer um dos dois casos, na VM:

```bash
docker compose --env-file .env -f infra/docker-compose.yml --profile workers up -d --build --remove-orphans
docker image prune -f
```

Se tambem usa Evolution local, acrescente `--profile evolution` ao ultimo comando. Nunca rode `down -v` em producao: isso remove dados persistidos da Evolution.

Se so uma parte do codigo mudou (por exemplo, so telas em `public/` ou so um worker), da para evitar rebuild/restart de tudo - rebuild e recrie apenas os servicos afetados:

```bash
docker compose --env-file .env -f infra/docker-compose.yml build api dispatch-worker
docker compose --env-file .env -f infra/docker-compose.yml up -d --no-deps api dispatch-worker
```

`--no-deps` evita que o compose tente recriar Redis/Evolution junto (eles nao tem `depends_on` circular aqui, mas o flag deixa a intencao explicita). Rode `docker compose ps` depois para confirmar que so os servicos esperados reiniciaram.

## 4.2. Deploy automatico por push (GitHub Actions)

Com isto configurado, todo push em `main` atualiza a VM sozinho: o GitHub Actions
conecta por SSH e roda `scripts/deploy.sh`, que faz fetch/reset para o commit
novo, `docker compose up -d --build --remove-orphans` e so considera o deploy
bem-sucedido se `/health` responder. O workflow e' `.github/workflows/deploy.yml`.

**Migrations do Supabase continuam manuais.** O deploy automatico nao aplica
nada no banco - aplique a migration antes do push quando o commit depender dela.

### a) Chave SSH exclusiva do deploy

Na sua maquina (nao na VM), gere um par so para o CI - assim voce revoga o
acesso do GitHub sem mexer na sua chave pessoal:

```bash
ssh-keygen -t ed25519 -C "github-actions-deploy" -f ~/.ssh/estimulo_deploy -N ""
```

Autorize a chave publica na VM:

```bash
ssh-copy-id -i ~/.ssh/estimulo_deploy.pub ubuntu@163.176.107.172
```

O usuario da VM precisa estar no grupo `docker` (a secao 1 ja faz isso com
`usermod -aG docker`), senao o `docker compose` do script pede sudo e falha.

Colete o known_hosts (evita desligar a verificacao de host no runner):

```bash
ssh-keyscan -H 163.176.107.172
```

### b) Secrets e variables no GitHub

Em **Settings > Secrets and variables > Actions** do repositorio:

| Tipo | Nome | Valor |
| --- | --- | --- |
| Secret | `ORACLE_HOST` | IP ou dominio da VM (ex.: `163.176.107.172`) |
| Secret | `ORACLE_USER` | usuario SSH (ex.: `ubuntu`) |
| Secret | `ORACLE_SSH_KEY` | conteudo **inteiro** de `~/.ssh/estimulo_deploy` (a chave privada, incluindo as linhas `BEGIN`/`END`) |
| Secret | `ORACLE_SSH_KNOWN_HOSTS` | saida do `ssh-keyscan` acima |
| Variable | `COMPOSE_PROFILES` | perfis usados na VM, separados por virgula (ex.: `workers` ou `workers,proxy`). Sem isso, assume `workers` |
| Variable | `ORACLE_APP_DIR` | caminho do projeto na VM, se nao for `~/estimulo-project` |

Os perfis precisam bater com os que a VM usa hoje. Se o deploy manual foi feito
com `--profile workers --profile proxy`, use `workers,proxy` - passar menos
perfis derruba os servicos que ficaram de fora.

### c) VM provisionada por rsync (caso da producao atual)

O script atualiza por `git fetch` + `git reset --hard origin/<branch>`. A VM de
producao (163.176.107.172) **nao e um checkout git** - foi copiada por rsync,
como descrito na secao "Atualizar" acima. O script detecta isso e converte o
diretorio em clone na primeira execucao (`git init` + `fetch` + `checkout -f`),
sem precisar de intervencao manual.

Nada fora do repositorio e afetado nessa conversao: `.env`, `credentials/` e
`storage/` sao gitignored e continuam no lugar. Arquivos que sobraram de rsyncs
antigos e nao existem mais no repositorio permanecem no disco como untracked -
o script nao apaga nada por conta propria.

O `reset --hard` **descarta** edicoes feitas direto na VM em arquivos
versionados. Isso e' proposital: o estado da VM passa a ser exatamente o do
commit. Se hoje ha ajustes feitos na mao no servidor, traga-os para o repositorio
antes de ligar o deploy automatico.

Se o repositorio for privado, a VM precisa conseguir autenticar no GitHub para
o `fetch` - configure um deploy key de leitura na VM, ou defina `REPO_URL` para
uma URL SSH que a chave da VM ja autorize.

### d) Primeiro teste

Rode o workflow manualmente antes de confiar no push: **Actions > Deploy Oracle
> Run workflow**. Os logs mostram cada passo; se `/health` nao responder em 30s,
o job falha e imprime os ultimos 80 logs da API.

Para rodar o mesmo script na mao, direto na VM:

```bash
COMPOSE_PROFILES=workers bash scripts/deploy.sh
```

## Rede Oracle e firewall local

Na Security List/NSG da VCN, libere entrada TCP:

| Porta | Origem | Uso |
| --- | --- | --- |
| 22 | somente seu IP administrativo | SSH |
| 3000 | temporariamente seu IP ou `0.0.0.0/0` para teste por IP | API HTTP sem TLS |
| 80 e 443 | `0.0.0.0/0`, somente quando houver proxy TLS | API publica por dominio/HTTPS |

Nao libere 6379, 5432, 5433 ou 8080. Se usar UFW, permita apenas as mesmas portas que estiverem realmente publicadas.

## Frontend Vercel

Defina no Vercel uma variavel publica, por exemplo `VITE_API_URL=https://api.seu-dominio.com`, e chame a API com credenciais:

```js
fetch(`${import.meta.env.VITE_API_URL}/access/status`, {
  credentials: "include",
});
```

O dominio Vercel completo deve estar em `CORS_ALLOWED_ORIGINS`. Para preview deployments, inclua cada origem explicitamente, separada por virgula. Nunca exponha no Vercel `SUPABASE_SERVICE_ROLE_KEY`, `EVOLUTION_API_KEY`, senha Redis ou chave Gemini.
