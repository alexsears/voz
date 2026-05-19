# Decisions

Record durable technical and product decisions here.

Use this format:

## YYYY-MM-DD - Decision Title

Decision:

Rationale:

Consequences:

## 2026-05-19 - Auto-pilot writer contract (FROZEN)

Decision: The auto-pilot observability/safety writer is frozen as built in
app/lib/{eventlog,classifier,policy}.js + app/policy.json:

- Three durable event types: asking_state (fact about the worker), decision
  (fact about Voz, references asking_event_id), approval (future: human
  approving a drafted reply). `dispatch` is logged too as a provenance anchor.
- Lookup key is (canonical_key, provenance). dispatched and autonomous are
  INDEPENDENT policy tables, not an inheritance hierarchy.
- Provenance from a dispatch context: opened on /dispatch, closed when the
  pane is observed idle. Uncertainty (context past a 15-min safety cap, or
  lost on restart) downgrades to "autonomous", the stricter table.
- Classifier normalizes a `capture-pane -pJ` capture (tmux rejoins its own
  wraps; no heuristic de-wrapping). Safety payload (verbatim command / file
  list) is a first-class field, NEVER folded into the canonical key. No live
  region positively identified => indeterminate => never auto-answers.
- Guards split: capture-pure (deterministic under replay) vs history-
  dependent. The recurrence guard counts prior DECISION events with
  outcome=answered for the exact tuple (the closed-loop signal), not
  asking_state events. Recurrence params {max_count, window_seconds} are
  per policy entry.
- Versioning: every decision stores policy_version AND classifier_version;
  asking_state stores the raw capture, so history replays deterministically.
- Decision outcomes: answered | suggested_and_queued | queued_unknown |
  abstained_indeterminate.

Rationale: See the design dialogue. Core principle governing every
patience-vs-speed choice: the cost asymmetry is unbounded (too patient costs
a retry; too eager costs whatever the command does). Urgency never grants
authority, only notification volume.

Consequences: policy.json ships enabled=false with empty tables, so v1 can
ONLY observe/classify/log; outcome "answered" is unreachable by construction.
The event log is read in the decision hot path (recurrence guard), so it is
not a write-only sink. app/events/ is gitignored (captured text is sensitive).
Open follow-ups: server-side presence signal (decision.presence.reachable is
null), the drafter (enables suggested_and_queued + approval events), wiring
the actual send, and a dashboard timeline view of /api/events/:project.

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
