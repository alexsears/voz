#!/usr/bin/env bash
set -euo pipefail

# Allow claude.exe to run even if launched from within a Claude Code session
unset CLAUDECODE 2>/dev/null || true

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

# --- Bootstrap MEMORY.md if missing ---
if [[ ! -f "${SCRIPT_DIR}/MEMORY.md" ]] && [[ -f "${SCRIPT_DIR}/memory-template.md" ]]; then
  echo ">> First run: creating MEMORY.md from template..."
  cp "${SCRIPT_DIR}/memory-template.md" "${SCRIPT_DIR}/MEMORY.md"
fi

echo ">> Starting Voz..."
echo ""

# Step 1: Run setup
echo ">> Step 1: Running setup..."
bash "${SCRIPT_DIR}/setup.sh"
echo ""

# Step 2: Launch Claude Code in each project window
echo ">> Step 2: Launching Claude Code in project windows..."
mapfile -t PROJECTS < <(parse_project_names)

for pname in "${PROJECTS[@]}"; do
  if [[ "$pname" == "voz" ]]; then
    continue
  fi
  echo "   Starting claude in '$pname'..."
  tmux send-keys -t "${SESSION}:${pname}" "claude.exe" Enter
  sleep 1
done
echo ""

# Step 3: Start the dashboard web app
echo ">> Step 3: Starting dashboard on http://localhost:4800 ..."
cd "${SCRIPT_DIR}/app"
# Kill any existing dashboard process
pkill -f "node.*voz/app/server.js\|node.*voicemode/app/server.js" 2>/dev/null || true
nohup node server.js > "${SCRIPT_DIR}/app/dashboard.log" 2>&1 &
DASH_PID=$!
echo "   Dashboard PID: $DASH_PID"
echo "$DASH_PID" > "${SCRIPT_DIR}/app/.dashboard.pid"
cd "$SCRIPT_DIR"
echo ""

# Step 4: Launch Claude Code with VoiceMode in voz window
echo ">> Step 4: Launching Voz Claude Code (with VoiceMode)..."
tmux send-keys -t "${SESSION}:voz" "claude.exe" Enter
echo ""

echo "========================================="
echo "  Voz is running!"
echo "========================================="
echo ""
echo "  Dashboard:  http://localhost:4800"
echo "  Attach:     tmux attach -t $SESSION"
echo ""
echo "  Quick commands:"
echo "    Status:  $SCRIPT_DIR/status.sh"
echo "    Stop:    $SCRIPT_DIR/stop.sh"
echo ""
echo "  Once attached, switch windows with:"
echo "    Ctrl-b n  (next window)"
echo "    Ctrl-b p  (previous window)"
echo "    Ctrl-b 0  (voz)"
echo ""
