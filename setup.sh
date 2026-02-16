#!/usr/bin/env bash
set -euo pipefail

# Allow claude.exe to run even if launched from within a Claude Code session
unset CLAUDECODE 2>/dev/null || true

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG="${SCRIPT_DIR}/projects.yaml"
SESSION="voz"

# --- YAML parser (no python/yq dependency) ---
# Extracts project names and paths from projects.yaml
parse_projects() {
  local name="" path=""
  while IFS= read -r line; do
    if [[ "$line" =~ ^[[:space:]]*-[[:space:]]*name:[[:space:]]*(.+)$ ]]; then
      name="${BASH_REMATCH[1]}"
      name="${name## }"
      name="${name%% }"
    elif [[ "$line" =~ ^[[:space:]]*path:[[:space:]]*(.+)$ ]]; then
      path="${BASH_REMATCH[1]}"
      path="${path## }"
      path="${path%% }"
      path="${path//\~/$HOME}"
      # Strip surrounding quotes if present
      path="${path%\"}"
      path="${path#\"}"
      path="${path%\'}"
      path="${path#\'}"
      if [[ -n "$name" ]]; then
        echo "${name}|${path}"
        name=""
        path=""
      fi
    fi
  done < "$CONFIG"
}

# --- Install VoiceMode MCP for the Voz orchestrator session ---
install_voicemode() {
  echo ">> Checking VoiceMode MCP..."
  # Check if voicemode MCP is already configured
  if claude.exe mcp list 2>/dev/null | grep -q "voicemode"; then
    echo "   VoiceMode MCP already configured."
  else
    echo "   Installing VoiceMode MCP server..."
    claude.exe mcp add --scope user voicemode -- uvx --refresh voice-mode || {
      echo "   WARNING: Could not auto-install VoiceMode MCP."
      echo "   Install manually: claude mcp add --scope user voicemode -- uvx --refresh voice-mode"
    }
  fi
}

# --- Validate config (auto-create from example on first run) ---
if [[ ! -f "$CONFIG" ]]; then
  if [[ -f "${SCRIPT_DIR}/projects.example.yaml" ]]; then
    echo ">> First run: creating projects.yaml from example..."
    cp "${SCRIPT_DIR}/projects.example.yaml" "$CONFIG"
  else
    echo "ERROR: No projects.yaml or projects.example.yaml found."
    exit 1
  fi
fi

# --- Install VoiceMode ---
install_voicemode

# --- Read projects ---
mapfile -t PROJECT_ENTRIES < <(parse_projects)

if [[ ${#PROJECT_ENTRIES[@]} -eq 0 ]]; then
  echo "ERROR: No projects found in $CONFIG"
  exit 1
fi

echo ">> Found ${#PROJECT_ENTRIES[@]} project(s) in config."

# --- Validate project directories ---
for entry in "${PROJECT_ENTRIES[@]}"; do
  IFS='|' read -r pname ppath <<< "$entry"
  if [[ ! -d "$ppath" ]]; then
    echo "WARNING: Directory does not exist for '$pname': $ppath"
    echo "         Creating it..."
    mkdir -p "$ppath"
  fi
done

# --- Create tmux session ---
if tmux has-session -t "$SESSION" 2>/dev/null; then
  echo ">> tmux session '$SESSION' already exists. Killing it first..."
  tmux kill-session -t "$SESSION"
fi

echo ">> Creating tmux session '$SESSION'..."

# First window is the voz control pane
tmux new-session -d -s "$SESSION" -n "voz" -c "$SCRIPT_DIR"

# Create a window for each project (skip voz — it's the control pane)
WIN_IDX=1
for entry in "${PROJECT_ENTRIES[@]}"; do
  IFS='|' read -r pname ppath <<< "$entry"
  if [[ "$pname" == "voz" ]]; then
    continue
  fi
  echo "   Creating window '$pname' -> $ppath"
  tmux new-window -t "${SESSION}:${WIN_IDX}" -n "$pname" -c "$ppath"
  ((WIN_IDX++))
done

# Switch back to voz window
tmux select-window -t "${SESSION}:voz"

echo ""
echo ">> Setup complete!"
echo "   Session: $SESSION"
echo "   Windows: voz $(printf '%s ' "${PROJECT_ENTRIES[@]}" | sed 's/|[^ ]*//g')"
echo ""
echo "   To attach: tmux attach -t $SESSION"
echo "   To start Claude instances, run: ~/voz/start.sh"
