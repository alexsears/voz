#!/usr/bin/env bash
set -euo pipefail

SESSION="voz"
DRY_RUN=false

usage() {
  echo "Usage: dispatch.sh [--dry-run] <project-name> <message>"
  echo ""
  echo "Send a message to a Claude Code instance in a tmux pane."
  echo ""
  echo "Options:"
  echo "  --dry-run    Show what would be sent without sending"
  echo ""
  echo "Examples:"
  echo "  dispatch.sh project-a \"Add a login page\""
  echo "  dispatch.sh --dry-run project-b \"Fix the CSS bug\""
  exit 1
}

# --- Parse args ---
if [[ $# -lt 1 ]]; then
  usage
fi

if [[ "$1" == "--dry-run" ]]; then
  DRY_RUN=true
  shift
fi

if [[ $# -lt 2 ]]; then
  usage
fi

TARGET="$1"
MESSAGE="$2"

# --- Validate tmux session ---
if ! tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "ERROR: tmux session '$SESSION' does not exist."
  echo "Run setup.sh first."
  exit 1
fi

# --- Validate target window ---
if ! tmux list-windows -t "$SESSION" -F '#{window_name}' | grep -qx "$TARGET"; then
  echo "ERROR: No window named '$TARGET' in session '$SESSION'."
  echo "Available windows:"
  tmux list-windows -t "$SESSION" -F '  #{window_name}'
  exit 1
fi

# --- Dispatch or dry-run ---
if $DRY_RUN; then
  echo "[DRY RUN] Would send to ${SESSION}:${TARGET}:"
  echo "  Message: $MESSAGE"
  echo "  Command: tmux send-keys -t ${SESSION}:${TARGET} -l \"\$MESSAGE\" && tmux send-keys -t ${SESSION}:${TARGET} Enter"
else
  echo ">> Dispatching to ${TARGET}..."

  # Use -l for literal string sending (avoids key interpretation issues)
  tmux send-keys -t "${SESSION}:${TARGET}" -l "$MESSAGE"
  tmux send-keys -t "${SESSION}:${TARGET}" Enter

  # Wait briefly then capture output to confirm receipt
  sleep 2
  echo ">> Captured output from ${TARGET}:"
  echo "---"
  tmux capture-pane -t "${SESSION}:${TARGET}" -p | tail -20
  echo "---"
fi
