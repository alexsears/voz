# Decisions

Record durable technical and product decisions here.

Use this format:

## YYYY-MM-DD - Decision Title

Decision:

Rationale:

Consequences:

## 2026-05-19 - Voz architecture is hybrid

Decision: Voz runs as a single orchestrator that handles most work inline
and only spawns a dedicated tmux Claude agent per project for long-running,
unattended, or parallel multi-project work. The dashboard treats "no tmux
session" as a normal standalone/hybrid idle state, not an error. See
CLAUDE.md "Hybrid Model".

Rationale: The original design (one tmux agent per project, always) now
overlaps with how the user actually works (one Claude window + subagents).
Hybrid keeps the lightweight default while preserving the ability to run
real parallel agents when a job needs it.

Consequences: localRefresh() always upserts the Voz session so the orb
reflects the orchestrator even with zero agents; renderStage() shows
"Voz standalone / Hybrid" instead of "No session detected". state.tmuxSession
tracks whether agents are live. Future agent spawn/teardown should be
on-demand and surfaced to the user.

## 2026-05-18 - Auto-pilot defaults to safe mode

Decision: Auto-pilot "safe mode" defaults ON (localStorage key
voz_autopilot_safe_mode; unset = safe). When safe mode is on,
autopilotCheck() returns early and never sends unattended replies. A
"SAFE" toggle button in the topbar lets the user explicitly opt out.

Rationale: The auto-pilot could send AI-decided keystrokes into agent
panes while the user is away with no review step. Defaulting to a guarded
state prevents surprise actions; opting out must be a deliberate click.

Consequences: Auto-pilot is inert until the user turns safe mode off.
Any future "act unattended" path must respect this flag.

## 2026-05-18 - Restart relaunch drops --dangerously-skip-permissions

Decision: The /api/project/:name/restart relaunch command no longer
appends --dangerously-skip-permissions (start.sh initial launch still
does, for unattended boot).

Rationale: A user-triggered restart is interactive; restored agents
should re-prompt for permissions rather than silently auto-approve.

Consequences: After a dashboard "restart", that agent will pause on
permission prompts until answered.

## 2026-05-18 - OpenAI model is env-configurable, default gpt-4o-mini

Decision: app/server.js reads OPENAI_CHAT_MODEL (default gpt-4o-mini)
instead of hardcoding gpt-4o for /api/openai/chat.

Rationale: Auto-pilot decisions are short/cheap; mini is sufficient and
much cheaper. Larger models opt-in via env.

Consequences: Default behavior is cheaper/faster; set OPENAI_CHAT_MODEL
to override per environment.
