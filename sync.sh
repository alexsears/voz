#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG="${SCRIPT_DIR}/projects.yaml"
MEMORY_TEMPLATE="${SCRIPT_DIR}/memory-template.md"
MEMORY_INSTRUCTIONS="${SCRIPT_DIR}/memory-instructions.md"

# --- YAML parser ---
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
      path="${path%\"}"
      path="${path#\"}"
      # Normalize WSL paths to Git Bash paths if not running in WSL
      if [[ ! -d "$path" ]] && [[ "$path" == /mnt/* ]]; then
        path="${path/\/mnt\/c\//\/c\/}"
      fi
      if [[ -n "$name" ]]; then
        echo "${name}|${path}"
        name=""
        path=""
      fi
    fi
  done < "$CONFIG"
}

ACTION="${1:-sync}"

case "$ACTION" in
  init)
    echo ">> Initializing memory for all projects..."
    mapfile -t ENTRIES < <(parse_projects)
    for entry in "${ENTRIES[@]}"; do
      IFS='|' read -r pname ppath <<< "$entry"
      if [[ ! -d "$ppath" ]]; then
        echo "   SKIP $pname (directory not found: $ppath)"
        continue
      fi

      # Create MEMORY.md if it doesn't exist
      if [[ ! -f "${ppath}/MEMORY.md" ]]; then
        echo "   Creating MEMORY.md in $pname..."
        cp "$MEMORY_TEMPLATE" "${ppath}/MEMORY.md"
      else
        echo "   MEMORY.md already exists in $pname"
      fi

      # Append memory instructions to CLAUDE.md (or create it)
      if [[ -f "${ppath}/CLAUDE.md" ]]; then
        if ! grep -q "Memory System (Voz)" "${ppath}/CLAUDE.md" 2>/dev/null; then
          echo "   Appending memory instructions to existing CLAUDE.md in $pname..."
          echo "" >> "${ppath}/CLAUDE.md"
          cat "$MEMORY_INSTRUCTIONS" >> "${ppath}/CLAUDE.md"
        else
          echo "   Memory instructions already in CLAUDE.md for $pname"
        fi
      else
        echo "   Creating CLAUDE.md with memory instructions in $pname..."
        echo "# ${pname}" > "${ppath}/CLAUDE.md"
        echo "" >> "${ppath}/CLAUDE.md"
        cat "$MEMORY_INSTRUCTIONS" >> "${ppath}/CLAUDE.md"
      fi
    done
    echo ""
    echo ">> Memory initialized. Run 'sync.sh sync' to commit."
    ;;

  sync)
    echo ">> Syncing memory across all projects..."
    echo "   $(date '+%Y-%m-%d %H:%M:%S')"
    echo ""
    mapfile -t ENTRIES < <(parse_projects)
    for entry in "${ENTRIES[@]}"; do
      IFS='|' read -r pname ppath <<< "$entry"
      if [[ ! -d "$ppath/.git" ]]; then
        echo "   SKIP $pname (not a git repo)"
        continue
      fi

      cd "$ppath"

      # Check if MEMORY.md or CLAUDE.md has changes
      if git diff --quiet MEMORY.md CLAUDE.md 2>/dev/null && git diff --cached --quiet MEMORY.md CLAUDE.md 2>/dev/null; then
        # Also check for untracked
        if ! git ls-files --others --exclude-standard | grep -qE '^(MEMORY|CLAUDE)\.md$'; then
          echo "   $pname: no memory changes"
          continue
        fi
      fi

      echo "   $pname: committing memory..."
      git add MEMORY.md CLAUDE.md 2>/dev/null || true
      git commit -m "memory: auto-sync $(date '+%Y-%m-%d %H:%M')" --no-verify 2>/dev/null || echo "   (nothing to commit)"
    done
    echo ""
    echo ">> Sync complete."
    ;;

  push)
    echo ">> Pushing memory to remotes..."
    mapfile -t ENTRIES < <(parse_projects)
    for entry in "${ENTRIES[@]}"; do
      IFS='|' read -r pname ppath <<< "$entry"
      if [[ ! -d "$ppath/.git" ]]; then
        continue
      fi
      cd "$ppath"
      if git remote get-url origin &>/dev/null; then
        echo "   $pname: pushing..."
        git push 2>/dev/null || echo "   (push failed for $pname)"
      else
        echo "   $pname: no remote"
      fi
    done
    echo ""
    echo ">> Push complete."
    ;;

  status)
    echo ">> Memory status across all projects..."
    echo ""
    mapfile -t ENTRIES < <(parse_projects)
    for entry in "${ENTRIES[@]}"; do
      IFS='|' read -r pname ppath <<< "$entry"
      echo "--- $pname ---"
      if [[ -f "${ppath}/MEMORY.md" ]]; then
        # Count non-empty, non-header lines
        LINES=$(grep -cvE '^(#|>|$)' "${ppath}/MEMORY.md" 2>/dev/null || echo "0")
        echo "   MEMORY.md: ${LINES} entries"
        # Show last modified
        if [[ -d "${ppath}/.git" ]]; then
          cd "$ppath"
          LAST=$(git log -1 --format='%ar' -- MEMORY.md 2>/dev/null || echo "never committed")
          echo "   Last updated: ${LAST}"
        fi
      else
        echo "   MEMORY.md: not found"
      fi
      echo ""
    done
    ;;

  *)
    echo "Usage: sync.sh {init|sync|push|status}"
    echo ""
    echo "  init    - Create MEMORY.md and update CLAUDE.md for all projects"
    echo "  sync    - Commit memory changes across all projects"
    echo "  push    - Push all projects to their remotes"
    echo "  status  - Show memory status for all projects"
    exit 1
    ;;
esac
