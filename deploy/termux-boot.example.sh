#!/data/data/com.termux/files/usr/bin/sh
# =============================================================================
# EXEMPLO de script de boot. Copie para ~/.termux/boot/ no TERMUX BASE.
#
#   mkdir -p ~/.termux/boot
#   cp "$PREFIX/var/lib/proot-distro/installed-rootfs/debian/root/projeto-faculdade/deploy/termux-boot.example.sh" \
#      ~/.termux/boot/start-projeto.sh
#   chmod +x ~/.termux/boot/start-projeto.sh
#
# Requisitos no Termux base:
#   pkg install proot-distro tmux
#   app Termux:Boot instalado (F-Droid)
# =============================================================================

termux-wake-lock 2>/dev/null || true
sleep 10

PREFIX="${PREFIX:-/data/data/com.termux/files/usr}"
export PATH="$PREFIX/bin:$PATH"

# O caminho lê o script de dentro do rootfs do Debian, sem precisar copiar nada.
ROOTFS="$PREFIX/var/lib/proot-distro/installed-rootfs/debian"
INNER="$ROOTFS/root/projeto-faculdade/deploy/termux-inner.sh"

if [ ! -f "$INNER" ]; then
  echo "Não encontrei $INNER" > "$HOME/boot-projeto.log"
  exit 1
fi

tmux has-session -t projeto 2>/dev/null || \
  tmux new-session -d -s projeto "bash $INNER"

echo "sessão 'projeto' iniciada em $(date)" >> "$HOME/boot-projeto.log"
