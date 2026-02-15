# Voz

Voice-controlled orchestrator for Claude Code. Talk to one Claude instance and have it delegate tasks to others running in separate tmux panes.

## Requirements

- Windows 11 with WSL (Ubuntu)
- tmux (installed in WSL)
- Claude Code CLI
- Node.js 18+

## Quick Start

```bash
# Clone
git clone <repo-url> ~/code/voz
cd ~/code/voz

# Install dashboard dependencies
cd app && npm install && cd ..

# Start everything
./start.sh
```

On first run, Voz creates a default config from `projects.example.yaml`. Then just talk to it:

- "Add project my-api at ~/code/my-api — it's a REST backend"
- "Add project my-app at ~/code/my-app — React frontend"
- "What projects do I have?"
- "Tell my-api to add a health endpoint"
- "How's my-app doing?"
- "Status of all projects"
- "Stop everything"

## Dashboard

The web dashboard runs at `http://localhost:4800` and shows all project panes with live output.

## How It Works

Voz creates a tmux session with one window per project. Each window runs a Claude Code instance. The orchestrator window (Voz) receives your voice commands via VoiceMode MCP and delegates to the others using `tmux send-keys`.

Each project automatically maintains a `MEMORY.md` file with important context that persists across sessions, committed to git automatically.

## Files

| File | Purpose |
|---|---|
| `projects.yaml` | Your projects (gitignored, auto-created from example) |
| `MEMORY.md` | Orchestrator memory (gitignored, auto-created) |
| `projects.example.yaml` | Sample config — edit and copy |
| `CLAUDE.md` | Instructions for the Voz Claude instance |
| `setup.sh` | Creates tmux session + windows |
| `start.sh` | One-command startup |
| `stop.sh` | Graceful shutdown |
| `dispatch.sh` | Send commands to project panes |
| `status.sh` | Capture output from all panes |
| `sync.sh` | Memory management (init/sync/push) |
| `app/` | Web dashboard (Express + vanilla HTML) |
