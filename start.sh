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

# --- Resolve full path to claude.exe (Windows path for cmd.exe) ---
CLAUDE_WIN_PATH=""
for p in "/mnt/c/Users/${USER}/.local/bin/claude.exe" "/mnt/c/Users/asear/.local/bin/claude.exe"; do
  if [[ -f "$p" ]]; then
    # Convert WSL path to Windows path: /mnt/c/Users/... → C:\Users\...
    CLAUDE_WIN_PATH="$(echo "$p" | sed 's|^/mnt/\(.\)|\U\1:|; s|/|\\|g')"
    break
  fi
done
if [[ -z "$CLAUDE_WIN_PATH" ]]; then
  # Try which
  local_bin="$(which claude.exe 2>/dev/null || echo "")"
  if [[ -n "$local_bin" ]]; then
    CLAUDE_WIN_PATH="$(echo "$local_bin" | sed 's|^/mnt/\(.\)|\U\1:|; s|/|\\|g')"
  fi
fi
if [[ -z "$CLAUDE_WIN_PATH" ]]; then
  echo "ERROR: claude.exe not found in PATH or common locations."
  echo "       Install Claude Code CLI or set the path manually."
  exit 1
fi
# Launch command: use cmd.exe to clear CLAUDECODE before running claude.exe
# This prevents the "nested session" error when launching from within Claude Code
CLAUDE_CMD="/mnt/c/Windows/System32/cmd.exe /c \"set CLAUDECODE= && ${CLAUDE_WIN_PATH} --dangerously-skip-permissions\""
echo ">> Using Claude binary: $CLAUDE_WIN_PATH"
echo ""

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
  tmux send-keys -t "${SESSION}:${pname}" "${CLAUDE_CMD}" Enter
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
echo ">> Step 4: Launching Voz orchestrator (with VoiceMode)..."
tmux send-keys -t "${SESSION}:voz" "${CLAUDE_CMD}" Enter
echo ""

echo "========================================="
echo "  Voz is running!"
echo "========================================="
echo ""
echo "  Dashboard:  http://localhost:4800"
echo "  Attach:     tmux attach -t $SESSION"
echo ""
echo "  Voice:      Attach to voz window, then say:"
echo "              \"Let's have a voice conversation\""
echo "              or use /voicemode:converse"
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
