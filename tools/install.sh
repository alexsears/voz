#!/usr/bin/env bash
# Idempotently install the voz shell helper into ~/.bashrc.
#
# Run from either Git Bash on Windows or WSL Ubuntu; it picks the right
# absolute path to voz.sh for the shell it is running in. Safe to re-run.
# To uninstall, delete the marked block from your ~/.bashrc.

set -e

case "$(uname -s)" in
  MINGW*|MSYS*) VOZ_SH="/c/code/voicemode/tools/voz.sh" ;;
  Linux*)
    if grep -qi microsoft /proc/version 2>/dev/null; then
      VOZ_SH="/mnt/c/code/voicemode/tools/voz.sh"
    else
      VOZ_SH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/voz.sh"
    fi
    ;;
  *) VOZ_SH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/voz.sh" ;;
esac

if [ ! -r "$VOZ_SH" ]; then
  echo "voz install: cannot find $VOZ_SH" >&2
  exit 1
fi

MARK_OPEN="# >>> voz shell helper >>>"
MARK_CLOSE="# <<< voz shell helper <<<"
TARGET="$HOME/.bashrc"
touch "$TARGET"

if grep -qF "$MARK_OPEN" "$TARGET" 2>/dev/null; then
  echo "voz: already installed in $TARGET (delete the marked block to uninstall)"
  exit 0
fi

{
  echo ""
  echo "$MARK_OPEN"
  echo "[ -r \"$VOZ_SH\" ] && source \"$VOZ_SH\""
  echo "$MARK_CLOSE"
} >> "$TARGET"

echo "voz: added to $TARGET"
echo "voz: open a new shell, or run:  source \"$TARGET\""
