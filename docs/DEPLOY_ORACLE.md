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

Atualizar (use os mesmos perfis escolhidos no deploy):

```bash
git pull --ff-only
docker compose --env-file .env -f infra/docker-compose.yml --profile workers up -d --build --remove-orphans
docker image prune -f
```

Se tambem usa Evolution local, acrescente `--profile evolution` ao ultimo comando. Nunca rode `down -v` em producao: isso remove dados persistidos da Evolution.

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
