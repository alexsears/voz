#!/usr/bin/env bash
# Run a command with node on PATH. Use this anywhere a non-interactive WSL
# bash needs node, since nvm only auto-loads in interactive shells.
#
#   tools/with-node.sh node app/lib/replay.js flashcards
#
# Reason this exists as a file: arg-strings passed through `wsl.exe -- bash
# -lc "..."` from Git Bash get inline variable assignments mangled by the
# Windows argv layer. A script file is read intact by bash, so its
# assignments stick.
if [ -z "$(command -v node)" ]; then
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  # shellcheck disable=SC1091
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
fi
if [ -z "$(command -v node)" ]; then
  echo "with-node.sh: node not found (nvm sourced or not). Install node in WSL." >&2
  exit 1
fi
exec "$@"
