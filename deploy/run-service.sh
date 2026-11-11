#!/usr/bin/env bash
# =============================================================================
# Mantém API + túnel rodando em primeiro plano (dentro do Debian do proot).
#
#   bash deploy/run-service.sh
#
# Não rode com "&" nem nohup: o proot encerra os processos quando a sessão sai.
# Quem mantém isso vivo é o tmux no Termux base (veja README 4.4).
# =============================================================================
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$APP_DIR/deploy/api.env"
LOG_DIR="$APP_DIR/deploy/logs"
TUNNEL_LOG="$LOG_DIR/tunnel.log"

say()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[aviso] %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m[erro] %s\033[0m\n' "$*" >&2; exit 1; }

[ -f "$ENV_FILE" ] || die "Rode 'bash deploy/install-debian.sh' primeiro."
mkdir -p "$LOG_DIR" "$APP_DIR/server/data"

set -a
. "$ENV_FILE"
set +a

PORT="${PORT:-3000}"
PROTOCOL="${TUNNEL_PROTOCOL:-http2}"

cd "$APP_DIR/server"

say "Subindo API na porta $PORT"
node server.js &
API_PID=$!

CF_PID=""
cleanup() {
  echo "[$(date '+%F %T')] encerrando serviços"
  [ -n "$CF_PID" ] && kill "$CF_PID" 2>/dev/null || true
  kill "$API_PID" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 130' INT TERM

HEALTHY=0
for _ in $(seq 1 40); do
  if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    HEALTHY=1
    break
  fi
  if ! kill -0 "$API_PID" 2>/dev/null; then
    echo "[erro] a API morreu ao iniciar. Rode 'node server.js' em $APP_DIR/server para ver o erro."
    exit 1
  fi
  sleep 0.5
done
[ "$HEALTHY" -eq 1 ] || die "A API não respondeu em 20s."
say "API respondendo em http://127.0.0.1:$PORT"

if [ -f "$APP_DIR/deploy/cloudflared.yml" ]; then
  HOST="$(awk '/hostname:/ {print $2; exit}' "$APP_DIR/deploy/cloudflared.yml")"
  say "Túnel fixo para https://$HOST"
  cloudflared tunnel --config "$APP_DIR/deploy/cloudflared.yml" run &
  CF_PID=$!
else
  say "Túnel rápido (a URL muda a cada reinício)"
  : > "$TUNNEL_LOG"
  cloudflared tunnel --protocol "$PROTOCOL" \
    --url "http://127.0.0.1:$PORT" --no-autoupdate >> "$TUNNEL_LOG" 2>&1 &
  CF_PID=$!

  URL=""
  for _ in $(seq 1 60); do
    URL="$(grep -oE 'https://[A-Za-z0-9.-]+\.trycloudflare\.com' "$TUNNEL_LOG" | head -n1 || true)"
    [ -n "$URL" ] && break
    kill -0 "$CF_PID" 2>/dev/null || break
    sleep 1
  done

  if [ -n "$URL" ]; then
    printf '\n\033[1;32m  TÚNEL: %s\033[0m\n  Coloque em vercel.json e faça deploy.\n\n' "$URL"
  else
    warn "URL ainda não apareceu. Veja: $TUNNEL_LOG"
  fi
fi

# Fica vivo enquanto API e túnel estiverem de pé. Se qualquer um cair, o
# termux-inner.sh reinicia tudo depois de 10s.
while kill -0 "$API_PID" 2>/dev/null && kill -0 "$CF_PID" 2>/dev/null; do
  sleep 5
done

if ! kill -0 "$API_PID" 2>/dev/null; then
  echo "[erro] a API caiu; o supervisor vai reiniciar em 10s."
fi
if ! kill -0 "$CF_PID" 2>/dev/null; then
  echo "[erro] o túnel caiu; o supervisor vai reiniciar em 10s."
fi
