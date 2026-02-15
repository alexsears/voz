#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG="${SCRIPT_DIR}/projects.yaml"
SESSION="voz"

# --- YAML parser ---
parse_project_names() {
  while IFS= read -r line; do
    if [[ "$line" =~ ^[[:space:]]*-[[:space:]]*name:[[:space:]]*(.+)$ ]]; then
      local name="${BASH_REMATCH[1]}"
      name="${name## }"
      name="${name%% }"
      echo "$name"
    fi
  done < "$CONFIG"
}

# --- Check session ---
if ! tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "No voz session running."
  exit 0
fi

echo ">> Stopping Voz..."

# Send /exit to all Claude instances
mapfile -t PROJECTS < <(parse_project_names)

# Stop project Claude instances
for pname in "${PROJECTS[@]}"; do
  if tmux list-windows -t "$SESSION" -F '#{window_name}' | grep -qx "$pname"; then
    echo "   Sending /exit to '$pname'..."
    tmux send-keys -t "${SESSION}:${pname}" -l "/exit"
    tmux send-keys -t "${SESSION}:${pname}" Enter
  fi
done

# Stop voz Claude instance
echo "   Sending /exit to 'voz'..."
tmux send-keys -t "${SESSION}:voz" -l "/exit"
tmux send-keys -t "${SESSION}:voz" Enter

# Wait for graceful shutdown
echo "   Waiting for Claude instances to exit..."
sleep 5

# Kill the tmux session
echo "   Killing tmux session '$SESSION'..."
tmux kill-session -t "$SESSION" 2>/dev/null || true

# Stop the dashboard server
echo "   Stopping dashboard..."
if [[ -f "${SCRIPT_DIR}/app/.dashboard.pid" ]]; then
  kill "$(cat "${SCRIPT_DIR}/app/.dashboard.pid")" 2>/dev/null || true
  rm -f "${SCRIPT_DIR}/app/.dashboard.pid"
fi
pkill -f "node.*voz/app/server.js\|node.*voicemode/app/server.js" 2>/dev/null || true

echo ""
echo ">> Voz stopped."
