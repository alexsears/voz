# Open Questions

Track unresolved work, blockers, unknowns, and follow-ups here.

- RESOLVED 2026-05-19: architecture is hybrid (see decisions.md). Follow-up:
  define the concrete trigger/criteria + mechanism for Voz to spawn a tmux
  agent on demand from the dashboard (button + API), and tear it down.
- Near-term focus chosen by user: voice loop polish + dashboard UX.
- RESOLVED 2026-05-19: auto-pilot writer contract frozen + built (observe/
  classify/log only, policy disabled). See decisions.md. Remaining follow-ups:
  - Server-side presence signal (decision.presence.reachable is currently null;
    the dashboard knows user activity, the server does not).
  - The drafter: generates drafted_reply, enables the suggested_and_queued
    outcome and the approval event (ask -> suggest -> approve -> send chain).
  - Wiring the actual send, gated on a reviewed, enabled policy.
  - Dashboard timeline view consuming GET /api/events/:project.
  - Tune classifier heuristics against the real captured corpus once a live
    tmux session has produced asking_state events with raw_capture.
  - Latency: freshness numeric bound for the recurrence query is a config
    tuning value (ship conservative), not a design question.
- No automated tests exist. Decide minimal test coverage for server.js
  (tmux command construction / WSL path conversion are the riskiest bits).
- Dashboard process is not supervised (nohup + pid file). Should it be a
  service / auto-restart on crash?
- notes/ workflow (AGENTS.md) and CLAUDE.md memory rules overlap with the
  global C:\code memory system. Reconcile to avoid divergent context.
