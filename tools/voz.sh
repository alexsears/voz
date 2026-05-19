# voz.sh — shell helper. Sourced from ~/.bashrc on both Git Bash and WSL.
#
# Subcommands: up, down, status, attach, dashboard, logs <p>, events <p>,
#              replay <p>, scaffold <p> <id>, cd, help
#
# Design: the tmux session lives in WSL Ubuntu. From a WSL shell, commands
# run directly. From Git Bash on Windows, commands are dispatched via
# `wsl.exe -d Ubuntu -- bash -lc '...'` so node and tmux resolve via your
# WSL profile. You get one verb from either shell.

__voz_env() {
  case "$(uname -s)" in
    Linux*)
      if grep -qi microsoft /proc/version 2>/dev/null; then echo "wsl"; else echo "linux"; fi ;;
    MINGW*|MSYS*) echo "gitbash" ;;
    *) echo "unknown" ;;
  esac
}

__voz_dir_for() {
  case "$1" in
    gitbash|linux) echo "/c/code/voicemode" ;;
    wsl) echo "/mnt/c/code/voicemode" ;;
    *) echo "/c/code/voicemode" ;;
  esac
}

# Run a command in WSL Ubuntu's bash. From Git Bash we hop via wsl.exe so the
# user's WSL profile loads (tmux/curl on PATH). From WSL we just exec.
#
# Note: arg-strings going through Git Bash -> wsl.exe -- bash -c lose inline
# variable assignments (the Windows argv layer mangles them). So commands
# that need node must invoke tools/with-node.sh, which is a real file and
# is read intact. Do NOT inline `export NVM_DIR=...` here, it silently
# vanishes from Git Bash.
__voz_in_wsl() {
  local cmd="$*"
  if [ "$(__voz_env)" = "gitbash" ]; then
    wsl.exe -d Ubuntu -- bash -lc "$cmd"
  else
    bash -lc "$cmd"
  fi
}

__voz_open_url() {
  local url="$1"
  case "$(__voz_env)" in
    gitbash) cmd.exe /c start "" "$url" >/dev/null 2>&1 ;;
    wsl)     command -v wslview >/dev/null && wslview "$url" || cmd.exe /c start "" "$url" ;;
    *)       xdg-open "$url" 2>/dev/null || echo "open: $url" ;;
  esac
}

voz() {
  local env dir wsldir sub
  env="$(__voz_env)"
  dir="$(__voz_dir_for "$env")"
  wsldir="$(__voz_dir_for wsl)"
  sub="${1:-help}"
  [ $# -gt 0 ] && shift

  case "$sub" in
    up)
      __voz_in_wsl "cd '$wsldir' && ./start.sh"
      ;;
    down)
      __voz_in_wsl "cd '$wsldir' && ./stop.sh"
      ;;
    status)
      __voz_in_wsl "cd '$wsldir' && ./status.sh"
      if curl -sf -m 2 http://localhost:4800/api/health >/dev/null 2>&1; then
        echo "dashboard: up   http://localhost:4800"
      else
        echo "dashboard: down"
      fi
      ;;
    attach)
      if [ "$env" = "gitbash" ]; then
        wsl.exe -d Ubuntu -- tmux attach -t voz
      else
        tmux attach -t voz
      fi
      ;;
    dashboard)
      __voz_open_url "http://localhost:4800"
      ;;
    logs)
      local proj="${1:?usage: voz logs <project>}"
      __voz_in_wsl "tail -n 80 -f '$wsldir/app/events/${proj}.jsonl'"
      ;;
    events)
      local proj="${1:?usage: voz events <project>}"
      local out
      out="$(curl -s -m 5 "http://localhost:4800/api/events/${proj}")" || { echo "dashboard not reachable"; return 1; }
      if command -v jq >/dev/null 2>&1; then echo "$out" | jq .; else echo "$out"; fi
      ;;
    replay)
      local proj="${1:?usage: voz replay <project>}"
      __voz_in_wsl "cd '$wsldir' && tools/with-node.sh node app/lib/replay.js '$proj'"
      ;;
    scaffold)
      local proj="${1:?usage: voz scaffold <project> <event_id>}"
      local eid="${2:?usage: voz scaffold <project> <event_id>}"
      __voz_in_wsl "cd '$wsldir' && tools/with-node.sh node app/lib/replay.js '$proj' --scaffold '$eid'"
      ;;
    list)
      __voz_in_wsl "cd '$wsldir' && tools/with-node.sh node app/lib/projects.js list"
      ;;
    scan)
      __voz_in_wsl "cd '$wsldir' && tools/with-node.sh node app/lib/projects.js scan"
      ;;
    add)
      local pname="${1:?usage: voz add <name> [path] [description]}"
      local ppath="${2:-}"
      local pdesc="${3:-}"
      [ $# -gt 0 ] && shift
      [ $# -gt 0 ] && shift
      [ $# -gt 0 ] && shift
      __voz_in_wsl "cd '$wsldir' && tools/with-node.sh node app/lib/projects.js add '$pname' '$ppath' '$pdesc'"
      ;;
    remove)
      local pname="${1:?usage: voz remove <name>}"
      __voz_in_wsl "cd '$wsldir' && tools/with-node.sh node app/lib/projects.js remove '$pname'"
      ;;
    cd)
      cd "$dir" || return 1
      ;;
    help|-h|--help|"")
      cat <<EOF
voz — orchestrator command (env: $env, dir: $dir)

  voz up                       start the stack (tmux + dashboard + Voz)
  voz down                     stop everything
  voz status                   tmux session + dashboard reachability
  voz attach                   tmux attach -t voz
  voz dashboard                open http://localhost:4800 in a browser
  voz logs <project>           tail the event-log JSONL for <project>
  voz events <project>         GET /api/events/<project> (pretty if jq)
  voz replay <project>         re-run classifier+policy, diff vs recorded
  voz scaffold <p> <event_id>  emit a policy entry stub from a real ask
  voz list                     list projects in projects.yaml
  voz scan                     diff projects.yaml vs C:\\code\\* (read-only)
  voz add <name> [path] [d]    add a project to projects.yaml
  voz remove <name>            remove a project from projects.yaml
  voz cd                       cd into the voz repo
EOF
      ;;
    *)
      echo "voz: unknown subcommand '$sub'. Try 'voz help'." >&2
      return 1
      ;;
  esac
}
