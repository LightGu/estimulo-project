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

cd "$APP_DIR"

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
