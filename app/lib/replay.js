#!/usr/bin/env node
// Deterministic replay tool for the auto-pilot event log.
//
// Why this exists (built before there is a corpus on purpose): the moment you
// start tweaking the classifier to handle real captures, you need to know
// whether the tweak silently changed the classification of some OTHER capture
// you already handled. Without this, classifier changes are tested by
// eyeballing whichever capture you were looking at, which is how classifiers
// acquire regressions. With this, every classifier or policy change is gated
// on a diff you actually read.
//
//   node app/lib/replay.js <project>            re-run + diff vs recorded
//   node app/lib/replay.js <project> --json     machine-readable diff
//   node app/lib/replay.js <project> --scaffold <asking_event_id>
//                                               emit a policy-entry stub
//                                               bound to that real event
//                                               (authoring-by-selection)
//
// Determinism note: the recurrence guard is history-dependent. Querying the
// live log during replay would contaminate the result. So replay reconstructs
// a SYNTHETIC decision history from the replay run itself, in chronological
// order, using each event's own timestamp as "now". Replay therefore matches
// what the system would actually have decided, not what it decided plus
// whatever else has since landed in the log.

import { readAllEvents } from "./eventlog.js";
import { classify, CLASSIFIER_VERSION } from "./classifier.js";
import { decide, loadPolicy } from "./policy.js";

function indexDecisionsByAsk(events) {
  const m = new Map();
  for (const ev of events) {
    if (ev.type === "decision" && ev.asking_event_id) m.set(ev.asking_event_id, ev);
  }
  return m;
}

async function replay(project) {
  const events = await readAllEvents(project);
  const decisionsByAsk = indexDecisionsByAsk(events);
  const asks = events
    .filter((e) => e.type === "asking_state")
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));

  const { version: policyVersion } = await loadPolicy();
  const synthetic = []; // { tsMs, canonical_key, provenance, outcome }
  const diffs = [];
  let replayed = 0;
  let skipped = 0;

  for (const ask of asks) {
    if (typeof ask.raw_capture !== "string") {
      skipped++;
      continue;
    }
    replayed++;
    const nowMs = Date.parse(ask.ts);
    const newC = classify(ask.raw_capture);

    // History query reconstructed from THIS replay, not the live log.
    const historyFn = async (ck, prov, windowSeconds) => {
      const cutoff = nowMs - windowSeconds * 1000;
      let count = 0;
      let oldest = null;
      for (const d of synthetic) {
        if (d.outcome !== "answered") continue;
        if (d.canonical_key !== ck || d.provenance !== prov) continue;
        if (d.tsMs < cutoff || d.tsMs >= nowMs) continue;
        count++;
        if (oldest === null || d.tsMs < oldest) oldest = d.tsMs;
      }
      return {
        count,
        windowSeconds,
        oldestConsidered: oldest ? new Date(oldest).toISOString() : null,
        asOf: ask.ts,
      };
    };

    const newD = await decide({
      classified: newC,
      provenance: ask.provenance, // provenance is a runtime fact, not re-derived
      historyFn,
    });
    synthetic.push({
      tsMs: nowMs,
      canonical_key: newD.canonical_key,
      provenance: ask.provenance,
      outcome: newD.outcome,
    });

    const recorded = decisionsByAsk.get(ask.id);
    const changes = {};
    if (ask.widget_type !== newC.widget_type)
      changes.widget_type = { from: ask.widget_type, to: newC.widget_type };
    if (ask.canonical_key !== newC.canonical_key)
      changes.canonical_key = { from: ask.canonical_key, to: newC.canonical_key };
    if (recorded && recorded.outcome !== newD.outcome)
      changes.outcome = { from: recorded.outcome, to: newD.outcome };

    if (Object.keys(changes).length) {
      diffs.push({
        asking_event_id: ask.id,
        ts: ask.ts,
        recorded_classifier_version: ask.classifier_version,
        recorded_policy_version: recorded ? recorded.policy_version : null,
        changes,
      });
    }
  }

  return {
    project,
    current_classifier_version: CLASSIFIER_VERSION,
    current_policy_version: policyVersion,
    replayed,
    skipped_no_capture: skipped,
    changed: diffs.length,
    diffs,
  };
}

// Authoring-by-selection: never hand-write a canonical key. Point at a real
// logged ask and get a stub keyed by exactly what the classifier emitted for
// it, with a pointer back to the motivating evidence.
async function scaffold(project, eventId) {
  const events = await readAllEvents(project);
  const ask = events.find((e) => e.type === "asking_state" && e.id === eventId);
  if (!ask) {
    console.error(`No asking_state event ${eventId} in project ${project}`);
    process.exit(1);
  }
  const table = ask.provenance === "dispatched" ? "dispatched" : "autonomous";
  const stub = {
    [ask.canonical_key]: {
      id: `${ask.canonical_key}@${eventId.slice(0, 8)}`,
      enabled: false,
      _motivated_by: eventId,
      _captured_payload: ask.safety_payload,
      _classifier_version: ask.classifier_version,
      allow_regex: null,
      denylist: [],
      recurrence: { max_count: 3, window_seconds: 120 },
      reply: null,
    },
  };
  console.log(`# Add under policy.json -> "${table}" (provenance: ${ask.provenance})`);
  console.log(`# This entry is bound to a real captured ask, not specified from scratch.`);
  console.log(JSON.stringify(stub, null, 2));
}

const [, , project, ...rest] = process.argv;
if (!project) {
  console.error("usage: node app/lib/replay.js <project> [--json] [--scaffold <event_id>]");
  process.exit(1);
}
if (rest[0] === "--scaffold") {
  await scaffold(project, rest[1]);
} else {
  const result = await replay(project);
  if (rest.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(
      `Replay ${result.project}: ${result.replayed} captures, ` +
        `${result.skipped_no_capture} skipped (no raw_capture), ` +
        `${result.changed} changed vs recorded.`
    );
    console.log(
      `classifier ${result.current_classifier_version}, policy ${result.current_policy_version}`
    );
    for (const d of result.diffs) {
      console.log(`\n  ${d.ts}  ${d.asking_event_id}`);
      for (const [field, c] of Object.entries(d.changes)) {
        console.log(`    ${field}: ${JSON.stringify(c.from)} -> ${JSON.stringify(c.to)}`);
      }
    }
    if (!result.changed) console.log("\n  No regressions. Safe to ship this version.");
  }
}
