#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG="${SCRIPT_DIR}/projects.yaml"
SESSION="voz"
LINES=${1:-20}

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
  echo "ERROR: tmux session '$SESSION' is not running."
  exit 1
fi

echo "========================================="
echo "  VOZ STATUS"
echo "  $(date '+%Y-%m-%d %H:%M:%S')"
echo "========================================="
echo ""

# Status of voz pane
echo "--- [voz] ---"
tmux capture-pane -t "${SESSION}:voz" -p | tail -"$LINES"
echo ""

# Status of each project pane
mapfile -t PROJECTS < <(parse_project_names)

# Filter out voz from project list
REAL_PROJECTS=()
for pname in "${PROJECTS[@]}"; do
  [[ "$pname" == "voz" ]] && continue
  REAL_PROJECTS+=("$pname")
done

if [[ ${#REAL_PROJECTS[@]} -eq 0 ]]; then
  echo "  No projects configured yet."
  echo "  Talk to Voz to add your projects, or edit projects.yaml."
else
  for pname in "${REAL_PROJECTS[@]}"; do
    if tmux list-windows -t "$SESSION" -F '#{window_name}' | grep -qx "$pname"; then
      echo "--- [$pname] ---"
      tmux capture-pane -t "${SESSION}:${pname}" -p | tail -"$LINES"
      echo ""
    else
      echo "--- [$pname] --- (window not found)"
      echo ""
    fi
  done
fi

echo "========================================="
echo "  Total projects: ${#REAL_PROJECTS[@]}"
echo "========================================="
