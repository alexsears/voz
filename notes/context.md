# Context

Project: voz (repo: alexsears/voz; local dir name: voicemode)
Path: C:\code\voicemode  (WSL: /mnt/c/code/voicemode)

Purpose:

- Voice-controlled orchestrator for Claude Code. One "Voz" Claude instance
  receives spoken commands (VoiceMode MCP) and delegates tasks to other
  Claude Code instances, one per project, each in its own tmux window.
- Ships a web dashboard ("Jarvis"/orb voice-first UI) showing live pane
  output, with wake word ("Hey Voz") and an OpenAI auto-pilot that can
  handle agents while the user is away.

Important files and directories:

- CLAUDE.md            - Voz orchestrator behavior/instructions
- AGENTS.md            - notes workflow (read/update notes/ before+after work)
- projects.yaml        - registered projects (name/path/description); gitignored
- MEMORY.md            - Voz cross-session memory; gitignored
- dispatch.sh          - send an instruction to a project's tmux window
- setup.sh / start.sh  - create tmux session+windows, launch claude.exe, dashboard
- stop.sh / status.sh  - tear down / summarize all project panes
- sync.sh              - init/sync/push per-project MEMORY.md across projects
- app/server.js        - Express dashboard API (port 4800), wraps tmux via WSL
- public/index.html    - single-file dashboard UI (all CSS+JS inline)
- app/dashboard.log    - dashboard stdout/stderr

Run/test/deploy commands:

- Full stack:        ./start.sh   (setup + launch agents + dashboard + Voz)
- Dashboard only:    cd app && node server.js   (http://localhost:4800)
- Syntax check:      node --check app/server.js
- Attach session:    tmux attach -t voz
- Stop everything:   ./stop.sh
- No automated test suite exists yet.

Architectural note (WSL bridging symmetry):

- Two layers bridge from Windows-side caller to WSL tmux: tools/voz.sh
  (human-facing, `wsl.exe -d Ubuntu -- bash -lc`) and app/server.js
  (machine-facing, the `wsl()` helper around `wsl -d Ubuntu -- bash -c`).
  Independent; either could be replaced without breaking the other. If
  ever consolidating, keep voz.sh: it is the seam users actually touch;
  the server bridge is replaceable with anything that can reach tmux.

Operational notes:

- Runs on Windows 11 via WSL Ubuntu + tmux; claude.exe launched through
  cmd.exe with CLAUDECODE cleared to avoid nested-session errors.
- Dashboard port: PORT env or 4800. OpenAI model: OPENAI_CHAT_MODEL env
  or gpt-4o-mini default. Auto-pilot needs MODE=local + OpenAI key.
- Per orchestrator memory (C:\code), the old tmux Voz was marked RETIRED
  and replaced by a single Claude Code orchestrator window. As of 2026-05-18
  active development resumed at the user's request.
