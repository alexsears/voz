# First Real Session Runbook

Read this BEFORE running `voz up` for the first real session. The point of
this file is not to make the session work; it is to make you watch the right
things, because the first contact with real Claude Code TUI output is the
moment several assumptions either hold or quietly do not.

## The three signals, in order of "this is the signal"

### 1. Does the dashboard load and show your projects at all?

If not, it is a `start.sh` problem, not a Voz problem. Debug the boring layer
first (tmux session, claude.exe launch, dashboard node process, port 4800).
Nothing the auto-pilot writer does matters until this is true.

### 2. Does a real permission prompt produce an `asking_state` event in ~10s?

After `voz up`, dispatch something that will hit a real bash permission
dialog (e.g., "list the files in this directory using bash"). Run
`voz events <project>` within ~10 seconds of the prompt appearing in the
tmux window.

What you want to see: one `asking_state` event with `widget_type:
"tool_confirm"`, `canonical_key: "tool_confirm:bash"`, the verbatim command
as `safety_payload`, and `live_region_identified: true`.

What it likely actually does: the classifier emits `indeterminate` because
real Claude Code output does not match the synthetic captures the v1
heuristics were tuned against. That is fine. It is the first real signal
about the gap between test data and the wild, and it is the input that
unblocks the next classifier tweak.

### 3. Does `voz replay <project>` run cleanly against 1-2 real events?

Run it even with almost nothing in the log. The point is to confirm replay's
synthetic-history reconstruction matches the schema the writer actually
emits when fed real data, not the schema we wrote against synthetic data.
Cheaper to discover any mismatch with two events than two hundred.

Expected: "Replay <project>: 1 capture, 0 changed vs recorded." If replay
itself errors, that is the bug to fix before anything else.

## Using voice

The dashboard has a wake-word orb baked in (browser Web Speech API), so
nothing extra to install. Requirements:

1. Open the dashboard in Chrome or Edge (Web Speech API does not work in
   Firefox). Localhost is fine.
2. Click the `MIC` button in the topbar. Allow microphone permission.
3. Say "Hey Voz" then your command. Browser STT transcribes it; the
   dashboard dispatches to the Voz Claude in tmux; replies come back as
   TTS so you do not have to look at the screen.

For the proactive planning conversation specifically, the phrase that
triggers it is one of: "let's plan", "what should we work on", "plan
today", "let's get started". The Voz Claude reads `CLAUDE.md`'s Daily
Planning section and walks you through hot/warm candidates one at a time.
Answers like "yes", "no", "never ask about that again" all work.

The orchestrator window (this Claude Code session, the one that becomes
Voz when you attach via `voz attach`) also has voicemode MCP, so you can
have the same conversation in the terminal without the browser if you
prefer. From inside the voz tmux window: say "let's have a voice
conversation" or run `/voicemode:converse`.

## What NOT to do in the first session

**Do not scaffold a policy entry.** The first session is a small sample.
The classifier-policy contract pays off when entries match patterns that
recur in real use; one-shot patterns are exactly the kind of guess that
ages into bugs. Use Voz for real work a few times, let the corpus
accumulate across sessions, then look at the whole and pick the patterns
that show up repeatedly. The scaffold command will still be there.

**Do not flip `policy.enabled` to true.** Even if every other signal
looks right. The send path is intentionally not wired in v1, so flipping
the flag would only produce `answered` decision events that go nowhere,
which is misleading log data.

## What to capture from the session

The boring "it worked" outcome is just as useful as the interesting "this
thing is weird" outcome. Paste back:

- Whether each of the three signals fired as expected.
- The first `asking_state` event verbatim, especially the `widget_type`,
  `canonical_key`, and `safety_payload` fields.
- Anything in `dashboard.log` that looks like an error.

That is the input that decides whether the next move is "tune the
classifier" or "keep using it and accumulate the corpus."
