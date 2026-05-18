# Open Questions

Track unresolved work, blockers, unknowns, and follow-ups here.

- Direction vs. current orchestrator: this Claude Code window is now the
  "live" orchestrator (per C:\code memory). Decide whether revived Voz is
  (a) a dashboard/UI layer over the same idea, (b) a standalone tmux stack
  again, or (c) something new. Roadmap discussion pending with user.
- Auto-pilot safety: safe mode now defaults ON and is toggleable in the UI.
  Open: should unattended AI replies ever be allowed, and with what guardrails
  (allowlist of safe responses, dry-run log, confirmation queue)?
- No automated tests exist. Decide minimal test coverage for server.js
  (tmux command construction / WSL path conversion are the riskiest bits).
- Dashboard process is not supervised (nohup + pid file). Should it be a
  service / auto-restart on crash?
- notes/ workflow (AGENTS.md) and CLAUDE.md memory rules overlap with the
  global C:\code memory system. Reconcile to avoid divergent context.
