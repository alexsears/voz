// Pane-text classifier: turns a tmux capture into a structured asking-state
// payload. v1 heuristics. These WILL be wrong against real Claude Code TUI
// output in ways we cannot predict from here; that is acceptable because the
// policy ships empty/disabled, so a misclassification costs a mislabeled log
// row, never an action. The log is the corpus we will tune these against.
//
// IMPORTANT: callers must capture with `tmux capture-pane -pJ` so tmux rejoins
// its own wrapped lines. This classifier deliberately does NOT heuristically
// de-wrap; it relies on -J to make a logical line one line at any width.

import { createHash } from "crypto";

// Bump on any change to normalization or classification logic. Stored on every
// asking_state event so a historical capture can be replayed deterministically
// against a new classifier and the outcomes diffed before shipping.
export const CLASSIFIER_VERSION = "v1.0.0";

const ANSI = /\x1B\[[0-9;?]*[ -/]*[@-~]/g;
// Box-drawing (U+2500..U+257F) and block elements (U+2580..U+259F).
const BOX = /[─-╿▀-▟]/g;

// Collapse the rendered screen into a stable logical form: drop ANSI and
// box art, trim trailing cell padding, squeeze internal whitespace runs,
// drop blank lines at the extremes. Newlines stay as logical separators.
export function normalize(raw) {
  const lines = (raw || "")
    .replace(ANSI, "")
    .replace(BOX, " ")
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").replace(/\s+$/g, ""));
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const normalized = lines.join("\n");
  const screenHash = createHash("sha256")
    .update(normalized)
    .digest("hex")
    .slice(0, 16);
  return { normalized, lines, screenHash };
}

// Is the live Claude composer/dialog actually on screen? If the user scrolled
// the pane up, the capture is scrollback and we must not act on it. Absence of
// a positive signal => indeterminate (conservative).
function liveRegionIdentified(lines) {
  const tail = lines.slice(-12).join("\n");
  return (
    /(\besc to interrupt\b)/i.test(tail) ||
    /(\? for shortcuts)/i.test(tail) ||
    /^\s*>\s?/m.test(tail) ||                       // input prompt
    /\bDo you want to\b/i.test(tail) ||             // permission dialog
    /\b\d+\.\s+(Yes|No)\b/.test(tail)               // enumerated options
  );
}

// Pull the verbatim command out of a bash permission / tool confirmation.
// This is the blast-radius payload and is recorded as a first-class field;
// it is never folded into the canonical key.
function extractBashCommand(lines) {
  const joined = lines.join("\n");
  let m = joined.match(/Bash command[^\n]*\n\s*([^\n]+)/i);
  if (m && m[1].trim()) return m[1].trim();
  m = joined.match(/\$\s+([^\n]+)/);
  if (m && m[1].trim()) return m[1].trim();
  return null;
}

function extractPaths(text) {
  const paths = new Set();
  const re = /([A-Za-z]:\\[^\s"']+|\/(?:mnt\/)?[\w./-]+)/g;
  let m;
  while ((m = re.exec(text)) !== null) paths.add(m[1]);
  return [...paths].slice(0, 20);
}

// Classify a raw capture. Returns the asking-state payload fields the writer
// will store (server adds id/ts/project/provenance/triggering_dispatch_id).
export function classify(raw) {
  const { normalized, lines, screenHash } = normalize(raw);
  const signals = [];
  const live = liveRegionIdentified(lines);

  const base = {
    classifier_version: CLASSIFIER_VERSION,
    screen_hash: screenHash,
    live_region_identified: live,
    signals,
    safety_payload: null,
    extracted_values: {},
  };

  if (!live) {
    signals.push("no_live_region");
    return { ...base, widget_type: "indeterminate", canonical_key: "indeterminate" };
  }

  const tail = lines.slice(-20).join("\n");
  const hasEnumeratedYesNo = /\b\d+\.\s+Yes\b/.test(tail) && /\b\d+\.\s+No\b/.test(tail);
  const asksProceed = /\bDo you want to (proceed|continue|make this edit|create)\b/i.test(tail);

  // Working: a spinner / interrupt hint and no decision widget.
  if (/\besc to interrupt\b/i.test(tail) && !hasEnumeratedYesNo) {
    signals.push("interrupt_hint");
    return { ...base, widget_type: "working", canonical_key: "working" };
  }

  // Permission / tool-use confirmation: enumerated Yes/No options.
  if (hasEnumeratedYesNo || asksProceed) {
    signals.push(hasEnumeratedYesNo ? "enumerated_yes_no" : "asks_proceed");
    const bash = extractBashCommand(lines);
    if (bash || /\bBash\b|\bcommand\b/i.test(tail)) {
      signals.push("bash_payload");
      return {
        ...base,
        widget_type: "tool_confirm",
        canonical_key: "tool_confirm:bash",
        safety_payload: bash,                       // verbatim, never canonicalized
        extracted_values: { command: bash },
      };
    }
    if (/\b(edit|write|create|update|delete|overwrite)\b/i.test(tail)) {
      const paths = extractPaths(tail);
      signals.push("file_payload");
      return {
        ...base,
        widget_type: "permission",
        canonical_key: "permission:file_op",
        safety_payload: paths.join("\n") || null,
        extracted_values: { paths, count: paths.length },
      };
    }
    return { ...base, widget_type: "permission", canonical_key: "permission:generic" };
  }

  // Error recovery: an error plus a retry-style prompt.
  if (/\b(retry|try again)\b\??/i.test(tail) && /\b(error|failed|timed out)\b/i.test(tail)) {
    signals.push("error_recovery");
    return { ...base, widget_type: "error_recovery", canonical_key: "error_recovery:retry" };
  }

  // Proactive question: assistant ended on a question, no decision widget.
  if (/\?\s*$/.test(normalized.trimEnd())) {
    signals.push("trailing_question");
    return { ...base, widget_type: "proactive_question", canonical_key: "proactive_question:generic" };
  }

  // Idle composer present, nothing pending.
  if (/^\s*>\s?$/m.test(tail) || /\? for shortcuts/i.test(tail)) {
    signals.push("idle_composer");
    return { ...base, widget_type: "idle", canonical_key: "idle" };
  }

  signals.push("unclassified");
  return { ...base, widget_type: "indeterminate", canonical_key: "indeterminate" };
}

// Asking widgets are the ones a decision must be made about.
export const ASKING_WIDGETS = new Set([
  "permission",
  "tool_confirm",
  "proactive_question",
  "error_recovery",
]);

// Pane states that mean "the dispatched work is done" => close the context.
export const IDLE_WIDGETS = new Set(["idle"]);
