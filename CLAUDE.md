# voicemode - engineering guide for the Voz voice app

This file is the engineering guide for working ON the voicemode codebase: the Voz
voice-controlled orchestrator app (VoiceMode input, tmux worker windows, `dispatch.sh`,
`projects.yaml`, the planner, the dashboard). Branch `revive-voz` is the active line of
development.

**This file does not define an operator persona.** The Voz orchestrator that Alex talks to,
its role, and the shared process are defined in `C:\code\CLAUDE.md` and `C:\code\COLLAB.md`.
Alex is not a new user, and nothing in this file should be read as an instruction to
onboard him, interview him about his projects, or behave as Voz. The sections below
document what the app does and how its pieces fit together, so that changes to the code
keep them working.

## How the App Works

- The Voz app runs in the `voz` window of a tmux session called `voz`
- Other Claude Code instances run in their own tmux windows, one per project
- The Voz app dispatches instructions to them using `dispatch.sh` (in this directory)
- It monitors their output using `tmux capture-pane`

## Hybrid Model (2026-05-19)

Voz runs hybrid: it does NOT require a dedicated tmux agent per project.

- **Inline** (no tmux agent) is the path for: quick questions, single-file edits,
  status checks, research, anything that finishes in one short turn.
- **A dedicated tmux agent** (`./setup.sh` window + launch claude) is spawned only
  for: long-running or multi-step work on a project, work the user wants to
  run unattended, or parallel work across several projects at once.
- The dashboard works with zero tmux agents. That is the normal idle state
  ("Voz standalone / Hybrid"), not an error. Agents spin up on demand.
- When the path is unclear, the app prefers inline and escalates to a tmux agent
  if the task grows. It tells the user when it spawns or tears down an agent.

## Available Projects

`projects.yaml` (in this directory) holds the current project list and their
descriptions. The app reads it at the start of every conversation so it knows what
is available.

## Project Management

The app can add, remove, and list projects dynamically. The config lives in
`projects.yaml`.

### "Add project X at ~/code/x" / "I have a project called X"
1. Ask for any missing info: name, path, short description.
2. Convert the path to WSL format if needed (`~/code/x` → `/mnt/c/code/x`, `C:\code\x` → `/mnt/c/code/x`).
3. Append to `projects.yaml`:
   ```bash
   cat >> projects.yaml << 'EOF'
     - name: <name>
       path: <wsl-path>
       description: "<description>"
   EOF
   ```
4. Verify the directory exists. If not, ask whether to create it.
5. Run `./sync.sh init` to create MEMORY.md and CLAUDE.md in the new project.
6. If the tmux session is running, create the window: `tmux new-window -t voz:<next-index> -n <name> -c <path>`
7. Confirm: "Added <name>. Want me to start Claude Code in it?"

### "Remove project X"
1. Confirm: "Remove <name> from Voz? This won't delete the project files."
2. If the tmux window exists, send /exit and kill it.
3. Remove the entry from `projects.yaml` using sed or rewrite the file.
4. Confirm removal.

### "List my projects" / "What projects do I have?"
Read `projects.yaml` and summarize each project with its name, path, and description.

## Daily Planning (conversational, voice-friendly)

When the user says any of: "let's plan", "what should we work on", "what's
active", "plan today", "let's get started", or anything synonymous, the app does
NOT guess. It runs the planner and walks the user through the candidates.

1. Run `node app/lib/plan.js --json` and parse the output. It returns:
   - `yaml`: the current projects.yaml entries
   - `denylist`: never-ask names (skipped silently)
   - `candidates`: an array sorted hot -> warm -> cold, each with `name`,
     `description`, `in_yaml`, `denied`, `dirty`, `dirty_files`, `branch`,
     `age_days`, `warmth`.
2. Skip anything where `in_yaml || denied || warmth === "cold"`.
3. For each remaining candidate, ASK the user (one prompt at a time, voice
   if the conversation is voice). The prompt is informative:
   - Hot:  "wealthplan has uncommitted changes (12 files on master). Want
           to pick up where you left off?" (default if no reply: yes)
   - Warm: "jobs had a commit 3 days ago. Working on it today?"
           (default if no reply: no)
4. Apply the answer:
   - yes -> `node app/lib/projects.js add <name>` (auto-fills path and
     description; they are not specified unless the user overrides)
   - no  -> do nothing (ask again next session)
   - never (or "stop asking", "drop it", "put it away") -> append the name
     to `app/voz.denylist.json` under `never_ask`, save the JSON
5. When done, summarize: "Added X. Skipped Y. Won't ask about Z again."
   Then if anything was added, tell the user to run `voz down && voz up`
   so the new tmux windows spawn, or offer to run it.

This is the proactive flow the user asked for: don't make them remember
which projects are warm; surface the signal and ask.

## Dispatching Tasks

The app sends a task to a project with:
```bash
./dispatch.sh <project-name> "<instruction>"
```

Example:
```bash
./dispatch.sh homeos "Add a new /health endpoint to the API"
```

## Monitoring Output

After dispatching, the app checks on a project's progress with:
```bash
tmux capture-pane -t voz:<project-name> -p | tail -50
```

For a summary of all projects:
```bash
./status.sh
```

## Meta-Commands

The app responds to these types of voice commands:

### "Status of all projects" / "What's everyone doing?"
Run `./status.sh` and summarize the output conversationally.

### "Status of project-x" / "How's project-x doing?"
```bash
tmux capture-pane -t voz:<project-name> -p | tail -50
```
Summarize what that instance is currently doing.

### "Switch to project-x" / "Show me project-x"
```bash
tmux select-window -t voz:<project-name>
```

### "Stop project-x" / "Cancel project-x"
Send Ctrl-C to interrupt, then optionally /exit:
```bash
tmux send-keys -t voz:<project-name> C-c
```

### "Stop everything" / "Shut it all down"
```bash
./stop.sh
```

## Voice Mode

The app uses VoiceMode as an MCP server (mbailey/voicemode). This provides:
- **Speech-to-text** via Whisper (local or OpenAI API)
- **Text-to-speech** via Kokoro (local) or OpenAI TTS
- **Smart silence detection**: stops recording when the user pauses

Voice mode is only on the Voz orchestrator session, not on the worker sessions. The
orchestrator hears the user and dispatches text commands to the workers.

To start a voice conversation, the user can say "let's talk" or use `/voicemode:converse`.

If voice mode isn't working, check:
1. `claude mcp list`: voicemode should be listed
2. OpenAI API key may be needed: `export OPENAI_API_KEY=...` (for cloud STT/TTS)
3. For fully local: Whisper.cpp + Kokoro must be installed

## Voice Interaction Guidelines (app behavior)

1. **Parse intent**: Figure out which project the user is talking about from context. If ambiguous, ask which project they mean.
2. **Confirm before dispatching**: For significant tasks, briefly confirm what is about to be sent and to which project.
3. **Summarize results**: After checking output, give a concise spoken summary rather than dumping raw terminal output.
4. **Be proactive**: If errors show up in a project's output during a status check, flag them to the user.
5. **Handle multi-project tasks**: If the user describes work that spans multiple projects, break it into per-project instructions and dispatch to each.
6. **Keep responses voice-friendly**: Short sentences. No code blocks in voice responses unless the user is reading the screen. Speak results, don't dump them.

## Important Notes

- Always use `dispatch.sh` rather than raw `tmux send-keys` to ensure proper quoting and error handling
- The dispatch script uses `-l` (literal) flag to avoid tmux key interpretation issues
- Wait at least 2 seconds after dispatching before capturing output
- When reading project output, focus on the most recent activity (last 20-50 lines)

## Cross-Project Memory

Each project has its own `MEMORY.md` that its Claude instance maintains automatically.
The orchestrator session also manages memory:

- **When dispatching**: Include relevant context from the orchestrator's MEMORY.md so the target instance has what it needs
- **When checking status**: If a project instance reports a finding worth remembering across projects, save it to the orchestrator's own MEMORY.md
- **Sync command**: `./sync.sh sync` commits all MEMORY.md files across projects; `./sync.sh push` pushes to remotes
- **Read project memory**: `cat /mnt/c/code/<project>/MEMORY.md` shows what a project instance knows

## Memory System (Voz)

This repo has a persistent memory file at `MEMORY.md` in the project root. It survives across sessions. **Read it at the start of every conversation.**

### When to Write to MEMORY.md (do this automatically, never ask)

**Always save immediately when:**
- You make or discover an architectural decision ("we use X because Y")
- You fix a bug that took effort to diagnose (save the root cause)
- You learn how a non-obvious part of the codebase works
- You discover a dependency, config, or environment quirk
- The user states a preference or convention ("always use X", "never do Y")
- You complete a feature or milestone (save what was built and where)
- You discover something is broken or fragile
- You establish a pattern that future sessions should follow

**Never save:**
- Temporary debugging state
- Things already documented in README or inline comments
- Obvious or generic knowledge

### Format
- Bullet points, not paragraphs
- Include file paths when referencing code
- Date entries when relevant: `- (2026-02-15) Switched from REST to WebSocket for X`

### After updating MEMORY.md
Commit MEMORY.md on the current task branch, never directly on main/master (the global
pre-commit hook blocks that), and it goes out with that branch's PR:
`git add MEMORY.md && git commit -m "memory: <brief description>"`
