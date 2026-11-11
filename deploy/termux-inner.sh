#!/usr/bin/env bash
# =============================================================================
# Roda no TERMUX BASE (não dentro do Debian).
#
# Mantém uma sessão do proot viva e reinicia o serviço se ele cair.
# O cloudflared e o node rodam dentro do Debian; este script só segura a sessão.
#
# Instale uma vez no Termux base:
#   pkg install proot-distro tmux
#
# Execute com tmux (veja README 4.4). Variáveis opcionais:
#   DISTRO=debian
#   APP_DIR_IN_DEBIAN=/root/projeto-faculdade
# =============================================================================
set -euo pipefail

DISTRO="${DISTRO:-debian}"
APP_DIR_IN_DEBIAN="${APP_DIR_IN_DEBIAN:-/root/projeto-faculdade}"

command -v proot-distro >/dev/null 2>&1 || {
  echo "proot-distro não encontrado. Rode no Termux base: pkg install proot-distro"
  exit 1
}

echo "[$(date '+%F %T')] supervisor iniciado ($DISTRO:$APP_DIR_IN_DEBIAN)"

while true; do
  proot-distro login "$DISTRO" -- bash -lc "bash $APP_DIR_IN_DEBIAN/deploy/run-service.sh" || true
  echo "[$(date '+%F %T')] serviço encerrou. Reiniciando em 10s..."
  sleep 10
done
