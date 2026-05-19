# Open Questions

Track unresolved work, blockers, unknowns, and follow-ups here.

- RESOLVED 2026-05-19: architecture is hybrid (see decisions.md). Follow-up:
  define the concrete trigger/criteria + mechanism for Voz to spawn a tmux
  agent on demand from the dashboard (button + API), and tear it down.
- Near-term focus chosen by user: voice loop polish + dashboard UX.
- Auto-pilot safety: safe mode now defaults ON and is toggleable in the UI.
  Open: should unattended AI replies ever be allowed, and with what guardrails
  (allowlist of safe responses, dry-run log, confirmation queue)?
- No automated tests exist. Decide minimal test coverage for server.js
  (tmux command construction / WSL path conversion are the riskiest bits).
- Dashboard process is not supervised (nohup + pid file). Should it be a
  service / auto-restart on crash?
- notes/ workflow (AGENTS.md) and CLAUDE.md memory rules overlap with the
  global C:\code memory system. Reconcile to avoid divergent context.
