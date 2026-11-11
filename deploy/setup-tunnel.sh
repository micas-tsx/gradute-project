#!/usr/bin/env bash
# =============================================================================
# Cria um túnel Cloudflare com URL fixa (api.seudominio.com) para a API local.
#
#   bash deploy/setup-tunnel.sh api.seudominio.com
#
# Requisitos:
#   - o domínio já adicionado na Cloudflare (nameservers apontando para ela)
#   - cloudflared instalado (install-debian.sh faz isso)
#
# O comando "cloudflared tunnel login" abre uma URL: abra no navegador do
# celular ou de outro aparelho e autorize o domínio. Isso só é feito uma vez.
# =============================================================================
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST="${1:-}"
NAME="${TUNNEL_NAME:-projeto-faculdade}"
PORT="${PORT:-3000}"

say()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[aviso] %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m[erro] %s\033[0m\n' "$*" >&2; exit 1; }

command -v cloudflared >/dev/null 2>&1 || die "cloudflared não encontrado. Rode install-debian.sh."
[ -n "$HOST" ] || die "Uso: bash deploy/setup-tunnel.sh api.seudominio.com"

mkdir -p "$HOME/.cloudflared"

if [ ! -f "$HOME/.cloudflared/cert.pem" ]; then
  say "Autorizando a Cloudflare (abra a URL que vai aparecer)"
  cloudflared tunnel login
else
  say "Conta Cloudflare já autorizada (~/.cloudflared/cert.pem)"
fi

say "Criando túnel '$NAME' (se ainda não existir)"
cloudflared tunnel create "$NAME" 2>/dev/null || warn "O túnel '$NAME' já existia; reaproveitando."

TUNNEL_ID="$(cloudflared tunnel list 2>/dev/null | awk -v n="$NAME" '$2 == n { print $1; exit }' || true)"
[ -n "$TUNNEL_ID" ] || die "Não consegui descobrir o ID do túnel '$NAME'. Veja: cloudflared tunnel list"

CRED_FILE="$HOME/.cloudflared/$TUNNEL_ID.json"
[ -f "$CRED_FILE" ] || die "Credenciais não encontradas em $CRED_FILE"

say "Apontando $HOST para o túnel (DNS)"
cloudflared tunnel route dns "$NAME" "$HOST" 2>/dev/null || warn "Registro DNS já existia ou não pôde ser criado."

CONFIG="$APP_DIR/deploy/cloudflared.yml"
cat > "$CONFIG" <<EOF
# Gerado por deploy/setup-tunnel.sh
tunnel: $TUNNEL_ID
credentials-file: $CRED_FILE
ingress:
  - hostname: $HOST
    service: http://127.0.0.1:$PORT
  - service: http_status:404
EOF

say "Configuração escrita em $CONFIG"
cat <<EOF

Pronto. Agora:
  1. Atualize vercel.json:
       "destination": "https://$HOST/api/:path*"
  2. Suba o serviço: bash $APP_DIR/deploy/run-service.sh
  3. Teste de fora:  curl https://$HOST/health
EOF
