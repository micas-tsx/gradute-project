#!/usr/bin/env bash
# =============================================================================
# Instala o necessário para a API DENTRO do Debian do proot-distro.
# NÃO rode este script no Termux base.
#
#   proot-distro login debian
#   cd /root/projeto-faculdade        # ajuste para onde o projeto está
#   bash deploy/install-debian.sh
#
# O que ele faz:
#   - instala ca-certificates, curl, xz-utils
#   - garante Node.js >= 18 (usa o do apt; se for antigo, instala o binário oficial)
#   - instala cloudflared
#   - cria server/data e deploy/api.env com SESSION_SECRET e ADMIN_TOKEN
# =============================================================================
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$APP_DIR/deploy/api.env"
NODE_MIN_MAJOR=18

say()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[aviso] %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m[erro] %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Rode como root. No proot-distro o usuário padrão já é root."
grep -qi '^ID=debian' /etc/os-release 2>/dev/null \
  || die "Isto não parece ser o Debian do proot. Entre com: proot-distro login debian"
command -v apt-get >/dev/null 2>&1 || die "apt-get não encontrado."

case "$(uname -m)" in
  aarch64|arm64) NODE_ARCH=arm64; CF_ARCH=arm64 ;;
  armv7l|armv6l) NODE_ARCH=armv7l; CF_ARCH=arm ;;
  x86_64|amd64)  NODE_ARCH=x64;   CF_ARCH=amd64 ;;
  *) die "Arquitetura não suportada: $(uname -m)" ;;
esac

say "Arquitetura detectada: $(uname -m)"

say "Atualizando índices e instalando pacotes básicos"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl xz-utils procps >/dev/null

# --- Node.js ----------------------------------------------------------------
node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  local major
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  case "$major" in (''|*[!0-9]*) return 1 ;; esac
  [ "$major" -ge "$NODE_MIN_MAJOR" ]
}

if node_ok; then
  say "Node.js já disponível: $(node -v)"
else
  say "Instalando Node.js LTS (binário oficial para linux-${NODE_ARCH})"
  TMP="$(mktemp -d)"
  BASE="https://nodejs.org/dist/latest-v22.x"
  FILE="$(curl -fsSL "$BASE/" | grep -o "node-v[0-9.]*-linux-${NODE_ARCH}\.tar\.xz" | head -n1 || true)"
  [ -n "$FILE" ] || die "Não encontrei o pacote do Node em $BASE"
  curl -fsSL "$BASE/$FILE" -o "$TMP/node.tar.xz"
  mkdir -p /opt/node
  tar -xJf "$TMP/node.tar.xz" -C /opt/node --strip-components=1
  rm -rf "$TMP"
  ln -sf /opt/node/bin/node /usr/local/bin/node
  ln -sf /opt/node/bin/npm  /usr/local/bin/npm
  ln -sf /opt/node/bin/npx  /usr/local/bin/npx
  node_ok || die "Falha ao instalar o Node.js."
  say "Node.js instalado: $(node -v)"
fi

# --- cloudflared ------------------------------------------------------------
if command -v cloudflared >/dev/null 2>&1; then
  say "cloudflared já instalado: $(cloudflared --version 2>/dev/null | head -n1)"
else
  say "Baixando cloudflared (linux-${CF_ARCH})"
  curl -fsSL \
    "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${CF_ARCH}" \
    -o /usr/local/bin/cloudflared
  chmod +x /usr/local/bin/cloudflared
  say "cloudflared instalado: $(cloudflared --version 2>/dev/null | head -n1)"
fi

# --- Pastas e segredos ------------------------------------------------------
say "Preparando pastas e segredos"
mkdir -p "$APP_DIR/server/data"
chmod 700 "$APP_DIR/server/data"

if [ -f "$ENV_FILE" ]; then
  say "Mantendo $ENV_FILE existente"
else
  OLD_UMASK="$(umask)"
  umask 077
  {
    echo "PORT=3000"
    echo "SESSION_SECRET=$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
    echo "ADMIN_TOKEN=$(node -e 'console.log(require("crypto").randomBytes(24).toString("hex"))')"
    echo "PUBLIC_ORIGIN="
  } > "$ENV_FILE"
  umask "$OLD_UMASK"
  say "Segredos gerados em deploy/api.env"
fi
chmod 600 "$ENV_FILE"

if ! getent hosts github.com >/dev/null 2>&1; then
  warn "DNS não está resolvendo. Se o túnel falhar, rode:"
  warn "  echo 'nameserver 1.1.1.1' > /etc/resolv.conf"
fi

cat <<EOF

=============================================================================
Instalação concluída.

  Projeto:     $APP_DIR
  Node:        $(node -v)
  Segredos:    $ENV_FILE   (chmod 600)
  Dados:       $APP_DIR/server/data/users.json
  Admin token: veja com  ->  grep ADMIN_TOKEN $ENV_FILE

Próximos passos
  1. Teste em primeiro plano:
       bash $APP_DIR/deploy/run-service.sh

  2. Para túnel com URL fixa (recomendado, precisa de domínio na Cloudflare):
       bash $APP_DIR/deploy/setup-tunnel.sh api.seudominio.com

  3. Para iniciar junto com o celular, veja a seção 4.4 do README.
=============================================================================
EOF
