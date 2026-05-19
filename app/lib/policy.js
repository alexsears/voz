// Policy object + guard evaluation + the decision function.
//
// The policy object is the lookup target for the frozen contract key
// (canonical_key, provenance). It is NOT a flat allowlist; it is a policy
// object with per-entry parameters, which is why the contract field is
// `policy_version`, not `allowlist_version`.
//
// Tables `dispatched` and `autonomous` are independent (same shape, separate
// rows). Uncertainty in provenance already resolved toward "autonomous"
// upstream (eventlog.resolveProvenance), the stricter table.
//
// Guards split into:
//   - capture-pure: pure functions of the asking-state event. Deterministic
//     under replay, which is what makes the log a test corpus.
//   - history-dependent: the recurrence guard, a function of prior DECISION
//     events with outcome=answered for the exact tuple. It is the closed-loop
//     safety signal (auto-pilot's own answers driving the loop), not telemetry.

import { readFile, stat } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createHash } from "crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const POLICY_FILE = join(__dirname, "..", "policy.json");

let cache = null; // { mtimeMs, policy, version }

// policy_version is a short hash of the exact file bytes. Stored on every
// decision event so a decision can be reproduced against the policy that made
// it, independently of classifier_version.
export async function loadPolicy() {
  const st = await stat(POLICY_FILE);
  if (cache && cache.mtimeMs === st.mtimeMs) return cache;
  const raw = await readFile(POLICY_FILE, "utf-8");
  const policy = JSON.parse(raw);
  const version = createHash("sha256").update(raw).digest("hex").slice(0, 16);
  cache = { mtimeMs: st.mtimeMs, policy, version };
  return cache;
}

function lookup(policy, canonicalKey, provenance) {
  const table = provenance === "dispatched" ? policy.dispatched : policy.autonomous;
  return (table && table[canonicalKey]) || null;
}

// Capture-pure guards. Each returns { guard_id, result, reason }.
function evalCapturePureGuards(entry, classified) {
  const guards = [];
  const payload = classified.safety_payload || "";

  guards.push({
    guard_id: "enabled",
    result: entry.enabled === false ? "fail" : "pass",
    reason: entry.enabled === false ? "entry disabled" : "entry enabled",
  });

  if (entry.allow_regex) {
    let ok = false;
    try { ok = new RegExp(entry.allow_regex).test(payload); } catch { ok = false; }
    guards.push({
      guard_id: "content_allow_regex",
      result: ok ? "pass" : "fail",
      reason: ok ? "payload matched allow_regex" : "payload did not match allow_regex",
    });
  }

  if (Array.isArray(entry.denylist) && entry.denylist.length) {
    const hit = entry.denylist.find((p) => {
      try { return new RegExp(p).test(payload); } catch { return false; }
    });
    guards.push({
      guard_id: "content_denylist",
      result: hit ? "fail" : "pass",
      reason: hit ? `payload matched denylist pattern ${hit}` : "payload clear of denylist",
    });
  }

  if (typeof entry.max_count === "number") {
    const n = classified.extracted_values?.count ?? 0;
    const ok = n <= entry.max_count;
    guards.push({
      guard_id: "count_threshold",
      result: ok ? "pass" : "fail",
      reason: `count ${n} ${ok ? "<=" : ">"} max_count ${entry.max_count}`,
    });
  }

  return guards;
}

// Make the decision. `historyFn(canonicalKey, provenance, windowSeconds)`
// returns the freshness-annotated recent-answered-decision count from the
// event log (the hot-path read).
//
// Returns the decision-event payload fields the writer will store (server
// adds id/ts/project and the asking_event_id cross-reference).
export async function decide({ classified, provenance, historyFn }) {
  const { policy, version } = await loadPolicy();
  const policy_version = version;

  // Indeterminate never auto-answers, regardless of anything else.
  if (
    classified.widget_type === "indeterminate" ||
    !classified.live_region_identified
  ) {
    return {
      outcome: "abstained_indeterminate",
      provenance,
      canonical_key: classified.canonical_key,
      matched_pattern_id: null,
      policy_version,
      classifier_version: classified.classifier_version,
      guards_evaluated: [],
      sent_reply: null,
      drafted_reply: null,
      rationale: "live region not positively identified",
    };
  }

  const entry = lookup(policy, classified.canonical_key, provenance);
  const guards_evaluated = [];

  // Empty/disabled policy, or no entry for this tuple => queue, never act.
  if (policy.enabled !== true || !entry) {
    return {
      outcome: "queued_unknown",
      provenance,
      canonical_key: classified.canonical_key,
      matched_pattern_id: null,
      policy_version,
      classifier_version: classified.classifier_version,
      guards_evaluated,
      sent_reply: null,
      drafted_reply: null,
      rationale: policy.enabled !== true ? "policy disabled" : "no policy entry for tuple",
    };
  }

  // Capture-pure guards first (cheap, side-effect free, always evaluated).
  const pure = evalCapturePureGuards(entry, classified);
  guards_evaluated.push(...pure);
  const purePassed = pure.every((g) => g.result === "pass");

  // History-dependent recurrence guard runs only if the pure guards passed.
  // If it was skipped, that is recorded explicitly (the contract wants guards
  // that did not run because of short-circuit to be visible in the audit).
  const rec = entry.recurrence || policy.defaults?.recurrence || { max_count: 3, window_seconds: 120 };
  if (!purePassed) {
    guards_evaluated.push({
      guard_id: "recurrence",
      result: "skipped",
      reason: "short_circuit: a capture-pure guard failed",
    });
  } else {
    const h = await historyFn(classified.canonical_key, provenance, rec.window_seconds);
    const ok = h.count < rec.max_count;
    guards_evaluated.push({
      guard_id: "recurrence",
      result: ok ? "pass" : "fail",
      reason: `${h.count} prior answered in ${rec.window_seconds}s ${ok ? "<" : ">="} max ${rec.max_count}`,
      freshness: { oldestConsidered: h.oldestConsidered, asOf: h.asOf },
    });
  }

  // All guards must have explicitly passed. A "skipped" recurrence guard only
  // ever occurs because a pure guard failed, so .every(pass) is correctly
  // false in that case too.
  const allPass = guards_evaluated.every((g) => g.result === "pass");

  // Answer only with an explicit canned reply on the entry and all guards
  // passing. No drafter exists in v1, so suggested_and_queued is unreachable
  // here by design; failures fall back to queue.
  if (allPass && typeof entry.reply === "string") {
    return {
      outcome: "answered",
      provenance,
      canonical_key: classified.canonical_key,
      matched_pattern_id: entry.id || classified.canonical_key,
      policy_version,
      classifier_version: classified.classifier_version,
      guards_evaluated,
      sent_reply: entry.reply,
      drafted_reply: null,
      rationale: "all guards passed; entry reply sent",
    };
  }

  return {
    outcome: "queued_unknown",
    provenance,
    canonical_key: classified.canonical_key,
    matched_pattern_id: entry.id || classified.canonical_key,
    policy_version,
    classifier_version: classified.classifier_version,
    guards_evaluated,
    sent_reply: null,
    drafted_reply: null,
    rationale: allPass ? "guards passed but entry has no reply" : "a guard failed",
  };
}
