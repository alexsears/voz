#!/usr/bin/env node
// voz plan: proactively figure out which projects you want as workers today
// and offer to add them, one prompt at a time.
//
// Rationale: projects.yaml is hand-curated (one Claude per entry). Auto-add
// is wrong (would spawn 30+ workers). Manual curation is friction. Middle
// ground: look at signals you actually trust about "I am working on this"
// (uncommitted changes is the strongest; recent commits is a hint) and ask
// per candidate. Answers persist: "never" goes to a denylist; "no" is just
// for this session.
//
//   node app/lib/plan.js              interactive Y/n/never prompts
//   node app/lib/plan.js --json       machine-readable signals, no prompts
//
// Designed so a voice front-end (Voz Claude in the tmux orchestrator window)
// can do the same flow conversationally, calling the same signal-gathering
// code path via --json and prompting via TTS+STT instead of readline.

import { readFileSync, writeFileSync, existsSync, statSync } from "fs";
import { execFileSync } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import readline from "readline";

import {
  parseProjects,
  discoverCandidates,
  describeFromReadme,
  addProjectEntry,
} from "./projects.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ORCH_DIR = join(__dirname, "..", "..");
const DENYLIST_FILE = join(ORCH_DIR, "app", "voz.denylist.json");

const WARM_DAYS = parseInt(process.env.VOZ_WARM_DAYS || "14", 10);

// --- denylist ---

function loadDenylist() {
  if (!existsSync(DENYLIST_FILE)) return { never_ask: ["voz"] };
  try { return JSON.parse(readFileSync(DENYLIST_FILE, "utf-8")); }
  catch { return { never_ask: ["voz"] }; }
}
function saveDenylist(d) {
  writeFileSync(DENYLIST_FILE, JSON.stringify(d, null, 2) + "\n", "utf-8");
}
function addToDenylist(name) {
  const d = loadDenylist();
  if (!d.never_ask) d.never_ask = [];
  if (!d.never_ask.includes(name)) d.never_ask.push(name);
  d.never_ask.sort();
  saveDenylist(d);
}

// --- git signals ---

function git(cwd, args) {
  try {
    return execFileSync("git", args, {
      cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 4000,
    }).trim();
  } catch { return null; }
}

function gitSignals(path) {
  if (!existsSync(join(path, ".git"))) return { repo: false };
  const lastIso = git(path, ["log", "-1", "--format=%cI"]);
  const dirty = git(path, ["status", "--porcelain"]);
  const branch = git(path, ["rev-parse", "--abbrev-ref", "HEAD"]);
  let ageDays = null;
  if (lastIso) {
    const t = Date.parse(lastIso);
    if (!isNaN(t)) ageDays = Math.floor((Date.now() - t) / 86400000);
  }
  return {
    repo: true,
    last_commit_iso: lastIso || null,
    age_days: ageDays,
    dirty: dirty != null && dirty.length > 0,
    dirty_files: dirty ? dirty.split("\n").length : 0,
    branch: branch || null,
  };
}

// --- classification ---

function classify(signals) {
  if (signals.dirty) return "hot";
  if (signals.age_days != null && signals.age_days <= WARM_DAYS) return "warm";
  return "cold";
}

// --- gather ---

function gather() {
  const yaml = parseProjects();
  const yamlNames = new Set(yaml.map((p) => p.name));
  const yamlPaths = new Set(yaml.map((p) => (p.path || "").replace(/\/+$/, "")));
  const deny = loadDenylist();
  const denySet = new Set(deny.never_ask || []);

  const all = discoverCandidates().map((c) => {
    const s = gitSignals(c.path);
    return {
      name: c.name,
      path: c.path,
      description: describeFromReadme(c.path),
      in_yaml: yamlNames.has(c.name) || yamlPaths.has(c.path.replace(/\/+$/, "")),
      denied: denySet.has(c.name),
      ...s,
      warmth: classify(s),
    };
  });
  // Hot first (uncommitted), then warm by recency, then cold.
  const order = { hot: 0, warm: 1, cold: 2 };
  all.sort((a, b) => {
    const w = order[a.warmth] - order[b.warmth];
    if (w !== 0) return w;
    return (a.age_days ?? 9999) - (b.age_days ?? 9999);
  });
  return all;
}

// --- interactive prompt ---

async function ask(rl, q) {
  return new Promise((res) => rl.question(q, (a) => res(a.trim())));
}

function isYes(s, defaultYes) {
  if (!s) return defaultYes;
  return /^y(es)?$/i.test(s);
}
function isNever(s) {
  return /^(never|stop|no.?never)$/i.test(s);
}

async function interactive() {
  const candidates = gather();
  const askable = candidates.filter((c) => !c.in_yaml && !c.denied && c.warmth !== "cold");
  const inYaml  = candidates.filter((c) => c.in_yaml);

  console.log("");
  console.log(`projects.yaml: ${parseProjects().length} entries`);
  console.log(`hot (uncommitted): ${candidates.filter(c => c.warmth==="hot").length}`);
  console.log(`warm (commit <= ${WARM_DAYS}d): ${candidates.filter(c => c.warmth==="warm").length}`);
  console.log(`cold or never-ask: ${candidates.length - askable.length - inYaml.length}`);
  console.log("");

  if (!askable.length) {
    console.log("nothing new to ask about. run 'voz scan' to see everything.");
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const added = [], skipped = [], denied = [];
  try {
    for (const c of askable) {
      const sig = c.warmth === "hot"
        ? `uncommitted changes (${c.dirty_files} files${c.branch ? `, on ${c.branch}` : ""})`
        : `last commit ${c.age_days}d ago`;
      const prompt = c.warmth === "hot"
        ? `${c.name}: ${sig}. Work on it? [Y/n/never] `
        : `${c.name}: ${sig}. Work on it? [y/N/never] `;
      const defaultYes = c.warmth === "hot";
      const a = await ask(rl, prompt);
      if (isNever(a)) {
        addToDenylist(c.name);
        denied.push(c.name);
        continue;
      }
      if (!isYes(a, defaultYes)) {
        skipped.push(c.name);
        continue;
      }
      try {
        addProjectEntry({ name: c.name, path: c.path, description: c.description });
        added.push(c.name);
      } catch (err) {
        console.log(`  (skipped ${c.name}: ${err.message})`);
        skipped.push(c.name);
      }
    }
  } finally {
    rl.close();
  }

  console.log("");
  if (added.length) {
    console.log(`added (${added.length}): ${added.join(", ")}`);
    console.log(`run 'voz down && voz up' to spawn tmux windows for them`);
  }
  if (skipped.length) console.log(`skipped this session (${skipped.length}): ${skipped.join(", ")}`);
  if (denied.length)  console.log(`never asking again (${denied.length}): ${denied.join(", ")}`);
}

// --- JSON output for voice frontend ---

function asJson() {
  const candidates = gather();
  const deny = loadDenylist();
  console.log(JSON.stringify({
    warm_days: WARM_DAYS,
    yaml: parseProjects(),
    denylist: deny.never_ask || [],
    candidates,
  }, null, 2));
}

const args = process.argv.slice(2);
if (args.includes("--json")) asJson();
else await interactive();
