// Event log writer for Voz auto-pilot observability.
//
// Contract (frozen 2026-05-19, see notes/decisions.md):
//   - Three durable event types: asking_state, decision, approval.
//     (We also record `dispatch` as a provenance anchor; it is not one of
//      the three audited safety events but the log needs it to attribute asks.)
//   - Append-only JSONL, one file per project: app/events/<project>.jsonl
//   - The log is read inside the decision hot path (recurrence guard), so it
//     exposes a freshness-bounded recent-history query indexed by the tuple
//     (project, canonical_key, provenance).
//   - Provenance comes from a dispatch context: opened when Voz dispatches to
//     a project, closed when the pane is observed idle/ready. If it cannot be
//     confirmed closed it is force-downgraded to "autonomous" after a safety
//     cap, because "autonomous" is the stricter table and uncertainty must
//     resolve toward less authority (the cost asymmetry principle).

import { appendFile, readFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EVENTS_DIR = join(__dirname, "..", "events");

// How long a dispatch context may stay open without an observed idle before
// provenance downgrades from "dispatched" to "autonomous". Conservative: a
// real task that runs longer than this simply loses dispatched-level
// authority, which only ever makes auto-pilot more cautious, never less.
const DISPATCH_CONTEXT_MAX_AGE_MS = 15 * 60 * 1000;

// In-memory dispatch contexts. Lost on restart by design: after a restart we
// cannot prove an ask is downstream of a pre-restart dispatch, so every ask
// is treated as autonomous until a new dispatch opens a context.
const dispatchContexts = new Map(); // project -> { dispatchId, openedTs }

function eventFile(project) {
  return join(EVENTS_DIR, `${project.replace(/[^\w.-]/g, "_")}.jsonl`);
}

async function ensureDir() {
  if (!existsSync(EVENTS_DIR)) await mkdir(EVENTS_DIR, { recursive: true });
}

// Append one event. Every event gets a stable id and server timestamp.
// Returns the stored event (with id/ts) so callers can cross-reference it.
export async function appendEvent(project, event) {
  await ensureDir();
  const stored = {
    id: randomUUID(),
    ts: new Date().toISOString(),
    project,
    ...event,
  };
  await appendFile(eventFile(project), JSON.stringify(stored) + "\n", "utf-8");
  return stored;
}

// --- Provenance / dispatch context ---

// Open (or refresh) the dispatch context for a project. Called right after a
// dispatch is sent. Returns the dispatch id so the caller can log it.
export function openDispatchContext(project) {
  const dispatchId = randomUUID();
  dispatchContexts.set(project, { dispatchId, openedTs: Date.now() });
  return dispatchId;
}

// Close the dispatch context. Called when the pane is observed idle/ready,
// i.e. the agent has finished what it was dispatched to do.
export function closeDispatchContext(project) {
  dispatchContexts.delete(project);
}

// Resolve provenance for an ask happening now in `project`.
//   - context open and within the safety cap  -> "dispatched"
//   - no context, or context past the cap      -> "autonomous"
// Uncertainty resolves to "autonomous" (the stricter table) on purpose.
export function resolveProvenance(project) {
  const ctx = dispatchContexts.get(project);
  if (!ctx) return { provenance: "autonomous", triggering_dispatch_id: null };
  if (Date.now() - ctx.openedTs > DISPATCH_CONTEXT_MAX_AGE_MS) {
    // Past the safety cap: stop granting dispatched-level authority.
    dispatchContexts.delete(project);
    return { provenance: "autonomous", triggering_dispatch_id: null };
  }
  return { provenance: "dispatched", triggering_dispatch_id: ctx.dispatchId };
}

// --- Reads ---

export async function readAllEvents(project) {
  const file = eventFile(project);
  if (!existsSync(file)) return [];
  const raw = await readFile(file, "utf-8");
  const out = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip corrupt line */ }
  }
  return out;
}

// Most recent events for the dashboard timeline (newest last).
export async function readEvents(project, limit = 200) {
  const all = await readAllEvents(project);
  return all.slice(-limit);
}

// Hot-path query for the history-dependent recurrence guard.
//
// Counts prior DECISION events with outcome === "answered" for the exact
// tuple (project, canonical_key, provenance) within `windowSeconds`. We count
// answered decisions, NOT asking_state events: the dangerous pattern is
// auto-pilot's own answers driving the recurrence (the closed loop), so the
// safety signal is "how many times did WE answer this", not "how many times
// was it asked".
//
// Returns a freshness-annotated result so the caller can reason about
// staleness relative to its own poll cadence.
export async function recentAnsweredDecisions(
  project, canonicalKey, provenance, windowSeconds
) {
  const all = await readAllEvents(project);
  const cutoff = Date.now() - windowSeconds * 1000;
  let count = 0;
  let oldestConsidered = null;
  for (const ev of all) {
    if (ev.type !== "decision") continue;
    if (ev.outcome !== "answered") continue;
    if (ev.canonical_key !== canonicalKey) continue;
    if (ev.provenance !== provenance) continue;
    const t = Date.parse(ev.ts);
    if (isNaN(t) || t < cutoff) continue;
    count++;
    if (oldestConsidered === null || t < oldestConsidered) oldestConsidered = t;
  }
  return {
    count,
    windowSeconds,
    oldestConsidered: oldestConsidered ? new Date(oldestConsidered).toISOString() : null,
    asOf: new Date().toISOString(),
  };
}
