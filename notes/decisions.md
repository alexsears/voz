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

## 2026-05-19 - Shell helper: one verb from either shell

Decision: tools/voz.sh provides `voz up|down|status|attach|dashboard|logs|
events|replay|scaffold|cd|help`. Installed idempotently into ~/.bashrc on
both Git Bash and WSL Ubuntu by tools/install.sh. From Git Bash the helper
dispatches into WSL via `wsl.exe -d Ubuntu -- bash -lc` so node and tmux
resolve through the WSL profile; from WSL it runs natively. One verb, same
spelling, both shells.

Rationale: The friction that kills hobby projects is not remembering how to
start them. Every command in the workflow (start/stop, tail a JSONL at a path
you would have to grep for, run replay or scaffold from inside the repo) was
context-switch and recall. Collapsing all of it under `voz <verb>` is the
single biggest "easier to use" lever and costs about fifteen minutes.

Consequences: All later ergonomic work (table in dashboard, scaffold-as-
button, voice-as-entry-point) is downstream of actually using Voz, which is
downstream of zero activation energy. To uninstall, delete the marked block
in ~/.bashrc.

## 2026-05-19 - Replay tool + authoring-by-selection discipline

Decision: app/lib/replay.js is the gate for every classifier/policy change.
It re-runs each logged raw_capture through the current classifier+policy and
diffs against the recorded outcome. The recurrence guard is fed a SYNTHETIC
decision history reconstructed from the replay run in chronological order
(each event's own ts as "now"), never the live log, so replay is
deterministic even with policy enabled. Provenance is taken from the recorded
asking_state event, not re-derived (it is a runtime fact).

Policy entries are NEVER hand-written. They are created with
`replay.js <project> --scaffold <asking_event_id>`, which keys the entry off
exactly what the classifier emitted for a real capture. Authoring is a
selection over the corpus, not a specification.

Rationale: A wrong-widget mislabel is cheap in v1 (nothing auto-answers) but
is a latent classifier-policy mismatch: a hand-written key that the classifier
never emits never matches, and you discover it while debugging across the
classifier-policy boundary, the worst place to debug. Pairwise validation
(one entry, against one real capture) keeps the contract honest without
validating the classifier in the abstract. The replay tool is cheap to build
before there is a corpus and a painful retrofit after two classifier versions
shipped on vibes.

Consequences: classifier_version stops being mere audit metadata and becomes
the input that answers "what did vN do to every capture vN-1 handled", which
is the question that decides whether vN ships. Workflow before shipping any
classifier/policy change: run replay, read the diff, only ship if the diff is
intended.

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
