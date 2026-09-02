#!/usr/bin/env bash
# Atualiza o deploy desta VM (Oracle) para o commit atual do branch configurado.
#
# Roda NA VM, nao na sua maquina. E' o mesmo procedimento manual da secao
# "Atualizar" de docs/DEPLOY_ORACLE.md, so que idempotente e verificando
# /health no fim - se o health falhar, sai com codigo != 0 para o CI acusar.
#
# Perfis do compose: passe em COMPOSE_PROFILES (separados por virgula).
#   COMPOSE_PROFILES=workers            -> API + Redis + workers
#   COMPOSE_PROFILES=workers,proxy      -> acima + Caddy/HTTPS
#   COMPOSE_PROFILES=workers,evolution  -> acima + Evolution local
set -euo pipefail

APP_DIR="${APP_DIR:-$HOME/estimulo-project}"
BRANCH="${DEPLOY_BRANCH:-main}"
PROFILES="${COMPOSE_PROFILES:-workers}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3000/health}"
HEALTH_RETRIES="${HEALTH_RETRIES:-30}"

REPO_URL="${REPO_URL:-https://github.com/LightGu/estimulo-project.git}"

cd "$APP_DIR"

# A VM de producao (163.176.107.172) foi provisionada por rsync, nao por
# git clone - ver secao "Atualizar" do docs/DEPLOY_ORACLE.md. Nesse diretorio
# todo comando git falha com "not a git repository", entao converte-se a copia
# em clone na primeira execucao, sem tocar no que nao e versionado: .env,
# credentials/ e storage/ ficam onde estao (nenhum deles esta no repositorio).
if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "==> $APP_DIR nao e um checkout git; convertendo em clone de $REPO_URL"
  git init -q
  git remote add origin "$REPO_URL"
  git fetch --depth=1 origin "$BRANCH"
  # checkout -f em vez de reset --hard: o reset deixaria os arquivos copiados
  # por rsync que nao existem mais no repositorio como untracked; o -f sobrescreve
  # a copia local com a versao versionada.
  git checkout -f -B "$BRANCH" "origin/$BRANCH"
  git branch --set-upstream-to="origin/$BRANCH" "$BRANCH" >/dev/null 2>&1 || true
fi

profile_args=()
IFS=',' read -ra _profiles <<< "$PROFILES"
for p in "${_profiles[@]}"; do
  p="$(echo "$p" | tr -d '[:space:]')"
  [ -n "$p" ] && profile_args+=(--profile "$p")
done

compose() {
  docker compose --env-file .env -f infra/docker-compose.yml "${profile_args[@]}" "$@"
}

previous_sha="$(git rev-parse HEAD)"
echo "==> commit atual: $previous_sha"

echo "==> git fetch/reset para origin/$BRANCH"
git fetch --prune origin "$BRANCH"
# reset --hard em vez de pull --ff-only: a VM nao deve ter commits locais, e
# um pull falha se alguem editou um arquivo versionado direto no servidor.
# O .env e credentials/ nao sao versionados, entao nao sao afetados.
git reset --hard "origin/$BRANCH"

new_sha="$(git rev-parse HEAD)"
echo "==> novo commit: $new_sha"

if [ "$previous_sha" = "$new_sha" ]; then
  echo "==> nenhum commit novo; recriando containers mesmo assim"
fi

echo "==> subindo containers (perfis: $PROFILES)"
compose up -d --build --remove-orphans

echo "==> aguardando $HEALTH_URL"
for i in $(seq 1 "$HEALTH_RETRIES"); do
  if curl -fsS --max-time 5 "$HEALTH_URL" >/dev/null 2>&1; then
    echo "==> health OK apos ${i}s"
    docker image prune -f >/dev/null 2>&1 || true
    compose ps
    exit 0
  fi
  sleep 1
done

echo "!! health falhou em $HEALTH_URL apos ${HEALTH_RETRIES}s" >&2
compose ps >&2
compose logs --tail 80 api >&2
exit 1
