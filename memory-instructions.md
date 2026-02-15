## Memory System (Voz)

You have a persistent memory file at `MEMORY.md` in this project root. It survives across sessions. **Read it at the start of every conversation.**

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
Run: `git add MEMORY.md && git commit -m "memory: <brief description>"`

A background process also auto-commits every 5 minutes as a safety net.
