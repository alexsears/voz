#!/usr/bin/env node
// Project registry CLI: list / scan / add / remove.
//
// projects.yaml is hand-curated on purpose. Voz spawns one Claude per entry,
// so mass-adding every directory under /c/code would be destructive. This
// tool keeps drift cheap to SEE (scan is read-only and prints the diff with
// ready-to-paste `voz add` lines for each candidate), and edits cheap to
// make (add/remove are one verb each, no yaml hand-editing).
//
//   node app/lib/projects.js list
//   node app/lib/projects.js scan
//   node app/lib/projects.js add <name> [path] [description]
//   node app/lib/projects.js remove <name>

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ORCH_DIR = join(__dirname, "..", "..");
const CONFIG = join(ORCH_DIR, "projects.yaml");
const CODE_ROOT = "/mnt/c/code";

// Mirrors server.js parseProjects(); kept compatible with that parser since
// the same file is consumed there.
export function parseProjects() {
  if (!existsSync(CONFIG)) return [];
  const lines = readFileSync(CONFIG, "utf-8").split("\n");
  const projects = [];
  let cur = {};
  for (const line of lines) {
    const n = line.match(/^\s*-\s*name:\s*(.+)$/);
    const p = line.match(/^\s*path:\s*(.+)$/);
    const d = line.match(/^\s*description:\s*"?([^"]*)"?$/);
    if (n) { if (cur.name) projects.push(cur); cur = { name: n[1].trim() }; }
    else if (p) cur.path = p[1].trim();
    else if (d) cur.description = d[1].trim();
  }
  if (cur.name) projects.push(cur);
  return projects;
}

// Looks-like-a-project filter: must have a .git or CLAUDE.md (or both). This
// is the same signal you'd use to recognize "I work on this," and it filters
// out vendored SDKs, screenshot dumps, incident folders, etc.
function looksLikeProject(name, fullPath) {
  if (name.startsWith("_") || name.startsWith(".")) return false;
  if (name === "node_modules") return false;
  try {
    if (existsSync(join(fullPath, ".git"))) return true;
    if (existsSync(join(fullPath, "CLAUDE.md"))) return true;
  } catch { /* ignore */ }
  return false;
}

export function discoverCandidates() {
  const out = [];
  let entries;
  try { entries = readdirSync(CODE_ROOT, { withFileTypes: true }); }
  catch { return out; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const full = join(CODE_ROOT, e.name);
    if (looksLikeProject(e.name, full)) {
      out.push({ name: e.name, path: full });
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

// Pull a one-line description from README.md or CLAUDE.md: the first
// non-blank, non-heading, non-image, non-pure-link line. Bounded to 80 chars.
export function describeFromReadme(projectPath) {
  for (const fname of ["README.md", "CLAUDE.md"]) {
    const f = join(projectPath, fname);
    if (!existsSync(f)) continue;
    let text;
    try { text = readFileSync(f, "utf-8"); } catch { continue; }
    const lines = text.split("\n").slice(0, 40);
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith("#")) continue;       // markdown heading
      if (line.startsWith("!")) continue;       // image
      if (line.startsWith("```")) continue;     // code fence
      if (/^[\[!`]/.test(line)) continue;       // link/badge lines
      let cleaned = line.replace(/[`*_]/g, "").replace(/\s+/g, " ").trim();
      if (cleaned.length < 8) continue;
      if (cleaned.length > 80) cleaned = cleaned.slice(0, 77).trimEnd() + "...";
      return cleaned;
    }
  }
  return "";
}

function fmtTable(rows, cols) {
  const widths = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] || "").length)));
  const line = (vals) => vals.map((v, i) => String(v || "").padEnd(widths[i])).join("  ").trimEnd();
  return [line(cols), line(cols.map(() => "-".repeat(1))), ...rows.map((r) => line(cols.map((c) => r[c] || "")))].join("\n");
}

function cmdList() {
  const ps = parseProjects();
  if (!ps.length) { console.log("(no projects in projects.yaml)"); return; }
  console.log(fmtTable(ps, ["name", "path", "description"]));
}

function cmdScan() {
  const ps = parseProjects();
  const yamlNames = new Set(ps.map((p) => p.name));
  // Dedupe by path too: a directory registered under a different yaml name
  // (e.g. C:/code/voicemode registered as "voz") is not a new candidate.
  const yamlPaths = new Set(ps.map((p) => (p.path || "").replace(/\/+$/, "")));
  const candidates = discoverCandidates().filter(
    (c) => !yamlNames.has(c.name) && !yamlPaths.has(c.path.replace(/\/+$/, ""))
  );

  // Heuristic to map yaml paths to disk: support both /mnt/c/... and C:\\...
  const exists = (p) => {
    try { return statSync(p).isDirectory(); } catch { return false; }
  };
  const active = ps.filter((p) => exists(p.path));
  const stale  = ps.filter((p) => !exists(p.path));

  console.log(`projects.yaml: ${ps.length} entries`);
  console.log(`  active (in voz + on disk):  ${active.map((p) => p.name).join(", ") || "(none)"}`);
  console.log(`  stale (in voz, missing):    ${stale.map((p) => p.name).join(", ") || "(none)"}`);
  console.log("");
  if (!candidates.length) {
    console.log("candidates: (none. every project-looking dir under /mnt/c/code is already in voz)");
    return;
  }
  console.log(`candidates (on disk, not in voz): ${candidates.length}`);
  console.log("");
  for (const c of candidates) {
    const desc = describeFromReadme(c.path);
    console.log(`  ${c.name}`);
    if (desc) console.log(`    ${desc}`);
    console.log(`    voz add ${c.name}`);
    console.log("");
  }
  if (stale.length) {
    console.log("Stale entries to prune:");
    for (const s of stale) console.log(`  voz remove ${s.name}`);
  }
}

function escDesc(s) {
  // Quote string for the description field; strip non-printable ASCII
  // (incl. control chars) and inner double quotes to keep the simple
  // yaml parser happy. Done char-by-char so the source contains no
  // literal control bytes (which would make git treat this as binary).
  let out = "";
  for (const ch of String(s || "")) {
    const c = ch.charCodeAt(0);
    out += (c >= 0x20 && c <= 0x7e) ? ch : " ";
  }
  return out.replace(/"/g, "'").trim();
}

// Pure-ish: append an entry to projects.yaml. Returns the added entry or
// throws on validation errors. No console output — callers print as they like.
export function addProjectEntry({ name, path, description }) {
  if (!name) throw new Error("name required");
  const ps = parseProjects();
  if (ps.some((p) => p.name === name)) throw new Error(`already in projects.yaml: ${name}`);
  const resolvedPath = path && path.trim() ? path.trim() : `${CODE_ROOT}/${name}`;
  if (!existsSync(resolvedPath)) throw new Error(`path does not exist: ${resolvedPath}`);
  const desc = description && description.trim()
    ? description.trim()
    : (describeFromReadme(resolvedPath) || `${name} project`);

  let body = "";
  if (existsSync(CONFIG)) body = readFileSync(CONFIG, "utf-8");
  if (!/^\s*projects\s*:/m.test(body)) body = "projects:\n" + body;
  if (!body.endsWith("\n")) body += "\n";
  body +=
    `  - name: ${name}\n` +
    `    path: ${resolvedPath}\n` +
    `    description: "${escDesc(desc)}"\n`;
  writeFileSync(CONFIG, body, "utf-8");
  return { name, path: resolvedPath, description: desc };
}

function cmdAdd(name, path, description) {
  if (!name) { console.error("usage: voz add <name> [path] [description]"); process.exit(1); }
  try {
    const e = addProjectEntry({ name, path, description });
    console.log(`added ${e.name}`);
    console.log(`  path: ${e.path}`);
    console.log(`  desc: ${e.description}`);
    console.log(`(restart voz with 'voz down && voz up' to spawn a tmux window for it)`);
  } catch (err) {
    console.error(err.message);
    if (/path does not exist/.test(err.message)) {
      console.error(`(pass an explicit path as the second arg, or create the dir first)`);
    }
    process.exit(1);
  }
}

function cmdRemove(name) {
  if (!name) { console.error("usage: voz remove <name>"); process.exit(1); }
  if (!existsSync(CONFIG)) { console.error("projects.yaml not found"); process.exit(1); }
  const lines = readFileSync(CONFIG, "utf-8").split("\n");
  const out = [];
  let i = 0;
  let removed = false;
  while (i < lines.length) {
    const m = lines[i].match(/^\s*-\s*name:\s*(.+)$/);
    if (m && m[1].trim() === name) {
      // Skip this list item: the `- name:` line and any subsequent indented
      // continuation lines until the next `- ` or non-indented line.
      i++;
      while (i < lines.length && !/^\s*-\s/.test(lines[i]) && /^\s+\S/.test(lines[i])) i++;
      removed = true;
      continue;
    }
    out.push(lines[i]);
    i++;
  }
  if (!removed) { console.error(`not found in projects.yaml: ${name}`); process.exit(1); }
  writeFileSync(CONFIG, out.join("\n"), "utf-8");
  console.log(`removed ${name}`);
  console.log(`(restart voz with 'voz down && voz up' so the tmux window goes away)`);
}

// Only run the CLI when this file is the entry point. When imported by
// plan.js etc., the dispatch block is skipped.
import { pathToFileURL } from "url";
const isEntry = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntry) {
  const [, , sub, ...args] = process.argv;
  switch (sub) {
    case "list":   cmdList(); break;
    case "scan":   cmdScan(); break;
    case "add":    cmdAdd(args[0], args[1], args.slice(2).join(" ")); break;
    case "remove": cmdRemove(args[0]); break;
    default:
      console.error("usage: node app/lib/projects.js <list|scan|add|remove> [...]");
      process.exit(1);
  }
}
