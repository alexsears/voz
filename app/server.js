import express from "express";
import { exec } from "child_process";
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { promisify } from "util";
import * as eventlog from "./lib/eventlog.js";
import { classify, ASKING_WIDGETS, IDLE_WIDGETS } from "./lib/classifier.js";
import { decide } from "./lib/policy.js";

const execAsync = promisify(exec);

const __dirname = dirname(fileURLToPath(import.meta.url));
const ORCH_DIR = join(__dirname, "..");
const CONFIG = join(ORCH_DIR, "projects.yaml");
const SESSION = "voz";
const PORT = process.env.PORT || 4800;

// The WSL bridge is a no-op when this process is ALREADY inside WSL (the
// /proc/version check is the canonical Microsoft signature). Without this,
// `wsl -d Ubuntu -- bash -c ...` from inside WSL re-enters WSL through
// wsl.exe and tmux calls fail silently. start.sh launches us from WSL, so
// this is the path that actually matters today.
const IN_WSL = (() => {
  try { return /microsoft/i.test(readFileSync("/proc/version", "utf-8")); }
  catch { return false; }
})();
const WSL = IN_WSL ? "" : "wsl -d Ubuntu --";

// Clean env: strip CLAUDECODE so child processes don't think they're nested
const cleanEnv = { ...process.env };
delete cleanEnv.CLAUDECODE;

// Convert Windows path to WSL path
function toWslPath(winPath) {
  return winPath.replace(/^([A-Za-z]):/, (_, d) => `/mnt/${d.toLowerCase()}`).replace(/\\/g, "/");
}
const WSL_ORCH_DIR = toWslPath(ORCH_DIR);
const DEFAULT_OPENAI_MODEL = process.env.OPENAI_CHAT_MODEL || "gpt-4o-mini";

const app = express();
app.use(express.json());

// CORS — allow the Vercel-hosted frontend to reach local API
app.use((_req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (_req.method === "OPTIONS") return res.status(200).end();
  next();
});

// *** Serve static files FIRST so the page loads instantly ***
app.use(express.static(join(ORCH_DIR, "public")));
app.get("/", (_req, res) => {
  res.sendFile(join(ORCH_DIR, "public", "index.html"));
});

// --- YAML parser (mirrors the bash scripts) ---
function parseProjects() {
  let lines;
  try {
    lines = readFileSync(CONFIG, "utf-8").split("\n");
  } catch {
    return [];
  }
  const projects = [];
  let current = {};
  for (const line of lines) {
    const nameMatch = line.match(/^\s*-\s*name:\s*(.+)$/);
    const pathMatch = line.match(/^\s*path:\s*(.+)$/);
    const descMatch = line.match(/^\s*description:\s*"?([^"]*)"?$/);
    if (nameMatch) {
      if (current.name) projects.push(current);
      current = { name: nameMatch[1].trim() };
    } else if (pathMatch) {
      current.path = pathMatch[1].trim().replace(/^~/, process.env.HOME || "");
    } else if (descMatch) {
      current.description = descMatch[1].trim();
    }
  }
  if (current.name) projects.push(current);
  return projects;
}

// --- Async helpers (non-blocking) ---
// `wsl()` wraps a command so it can be executed in the WSL Ubuntu environment.
// When this process is already inside WSL, the wrapper just becomes `bash -c`;
// re-entering through `wsl.exe` from inside WSL silently breaks tmux calls.
function wsl(cmd) {
  const escaped = cmd.replace(/"/g, '\\"');
  const inner = `bash -c "unset CLAUDECODE 2>/dev/null; ${escaped}"`;
  return WSL ? `${WSL} ${inner}` : inner;
}

const execOpts = { encoding: "utf-8", env: cleanEnv };

// Cached session state — refreshed in background
let cachedSession = null;   // { active: bool, windows: string[], ts: number }
const CACHE_TTL = 2000;     // 2s cache

async function sessionExists() {
  if (cachedSession && Date.now() - cachedSession.ts < CACHE_TTL) return cachedSession.active;
  try {
    await execAsync(wsl(`tmux has-session -t ${SESSION} 2>/dev/null`), execOpts);
    cachedSession = { active: true, windows: cachedSession?.windows || [], ts: Date.now() };
    return true;
  } catch {
    cachedSession = { active: false, windows: [], ts: Date.now() };
    return false;
  }
}

async function capturePane(windowName, lines = 40) {
  try {
    const { stdout: raw } = await execAsync(
      wsl(`tmux capture-pane -t ${SESSION}:${windowName} -pJ 2>/dev/null`),
      { ...execOpts, timeout: 5000 }
    );
    const allLines = raw.split("\n");
    return allLines.slice(-lines).join("\n");
  } catch {
    return null;
  }
}

async function windowExists(name) {
  try {
    const { stdout: out } = await execAsync(
      wsl(`tmux list-windows -t ${SESSION} -F '#{window_name}' 2>/dev/null`),
      execOpts
    );
    const windows = out.split("\n").map((l) => l.trim());
    // Update cache with window list
    if (cachedSession) cachedSession.windows = windows;
    return windows.includes(name);
  } catch {
    return false;
  }
}

// Capture ALL panes in one WSL call (much faster than N separate calls)
async function captureAllPanes(projectNames, lines = 20) {
  // Build a single bash command that captures all panes
  const cmds = projectNames.map(
    name => `echo "___PANE_${name}___"; tmux capture-pane -t ${SESSION}:${name} -pJ 2>/dev/null || echo "___NOWINDOW___"`
  );
  const combined = cmds.join("; ");

  try {
    const { stdout: raw } = await execAsync(wsl(combined), { ...execOpts, timeout: 10000 });
    const result = {};
    let currentName = null;
    let currentLines = [];

    for (const line of raw.split("\n")) {
      const marker = line.match(/^___PANE_(.+)___$/);
      if (marker) {
        if (currentName) {
          const trimmed = currentLines.slice(-lines).join("\n");
          result[currentName] = currentLines.some(l => l === "___NOWINDOW___") ? null : trimmed;
        }
        currentName = marker[1];
        currentLines = [];
      } else {
        currentLines.push(line);
      }
    }
    if (currentName) {
      const trimmed = currentLines.slice(-lines).join("\n");
      result[currentName] = currentLines.some(l => l === "___NOWINDOW___") ? null : trimmed;
    }
    return result;
  } catch {
    return {};
  }
}

async function wslExec(cmd) {
  return execAsync(wsl(cmd), execOpts);
}

// --- Routes ---

// List projects from config
app.get("/api/projects", async (_req, res) => {
  const projects = parseProjects();
  const active = await sessionExists();
  if (!active) return res.json({ session: false, projects: projects.map(p => ({ ...p, windowActive: false })) });

  // One WSL call to get all windows
  try {
    const { stdout } = await execAsync(
      wsl(`tmux list-windows -t ${SESSION} -F '#{window_name}' 2>/dev/null`), execOpts
    );
    const windows = new Set(stdout.split("\n").map(l => l.trim()));
    const result = projects.map(p => ({ ...p, windowActive: windows.has(p.name) }));
    res.json({ session: true, projects: result });
  } catch {
    res.json({ session: active, projects: projects.map(p => ({ ...p, windowActive: false })) });
  }
});

// Get output from a project pane
app.get("/api/project/:name/output", async (req, res) => {
  const lines = parseInt(req.query.lines) || 40;
  if (!(await sessionExists())) return res.json({ error: "session_not_running", output: null });
  const output = await capturePane(req.params.name, lines);
  if (output === null) return res.json({ error: "window_not_found", output: null });
  res.json({ output });
});

// Get status of all projects — ONE WSL call for all panes
app.get("/api/status", async (_req, res) => {
  if (!(await sessionExists())) return res.json({ session: false, projects: [] });
  const projects = parseProjects();
  const allNames = [...projects.map(p => p.name), "voz"];

  // Single WSL call captures everything
  const panes = await captureAllPanes(allNames);

  const result = projects.map((p) => ({
    ...p,
    active: panes[p.name] !== null && panes[p.name] !== undefined,
    output: panes[p.name] || null,
  }));

  res.json({
    session: true,
    voz: { output: panes["voz"] || null },
    projects: result,
  });
});

// Dispatch a command to a project
app.post("/api/project/:name/dispatch", async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: "message required" });
  if (!(await sessionExists())) return res.status(503).json({ error: "session not running" });

  try {
    const safeMsg = message.replace(/"/g, '\\"').replace(/'/g, "'\\''");
    await execAsync(
      wsl(`bash '${WSL_ORCH_DIR}/dispatch.sh' '${req.params.name}' '${safeMsg}'`),
      { ...execOpts, timeout: 10000 }
    );
    // Open the provenance context and anchor it in the log. Asks observed
    // while this is open attribute to this dispatch ("dispatched").
    const dispatchId = eventlog.openDispatchContext(req.params.name);
    await eventlog.appendEvent(req.params.name, {
      type: "dispatch",
      dispatch_id: dispatchId,
      message,
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Send Ctrl-C to a project
app.post("/api/project/:name/stop", async (req, res) => {
  if (!(await sessionExists())) return res.status(503).json({ error: "session not running" });
  try {
    await wslExec(`tmux send-keys -t ${SESSION}:${req.params.name} C-c`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Send /exit to a project's Claude
app.post("/api/project/:name/exit", async (req, res) => {
  if (!(await sessionExists())) return res.status(503).json({ error: "session not running" });
  try {
    await wslExec(`tmux send-keys -t ${SESSION}:${req.params.name} -l '/exit'`);
    await wslExec(`tmux send-keys -t ${SESSION}:${req.params.name} Enter`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Restart a project's Claude (exit + relaunch)
app.post("/api/project/:name/restart", async (req, res) => {
  if (!(await sessionExists())) return res.status(503).json({ error: "session not running" });
  const name = req.params.name;
  if (!(await windowExists(name)))
    return res.status(404).json({ error: `window '${name}' not found` });

  // Send Ctrl-C + /exit to stop current Claude
  try {
    await wslExec(`tmux send-keys -t ${SESSION}:${name} C-c`);
    await wslExec(`tmux send-keys -t ${SESSION}:${name} -l '/exit'`);
    await wslExec(`tmux send-keys -t ${SESSION}:${name} Enter`);
  } catch { /* may fail if not in Claude, that's ok */ }

  // Wait for exit, then relaunch — use tmux send-keys directly (no wsl() wrapper)
  // to avoid double-escaping the complex cmd.exe command
  const launchKeys = `/mnt/c/Windows/System32/cmd.exe /c "set CLAUDECODE= && C:\\\\Users\\\\asear\\\\.local\\\\bin\\\\claude.exe"`;

  setTimeout(async () => {
    try { await wslExec(`tmux send-keys -t ${SESSION}:${name} C-c`); } catch {}
    setTimeout(async () => {
      try {
        // Send the launch command character-by-character via -l, then Enter.
        // Run through WSL only when not already inside it; otherwise tmux is
        // already on this side of the bridge.
        const prefix = WSL ? `${WSL} ` : "";
        await execAsync(
          `${prefix}tmux send-keys -t ${SESSION}:${name} -l '${launchKeys}'`,
          execOpts
        );
        await execAsync(
          `${prefix}tmux send-keys -t ${SESSION}:${name} Enter`,
          execOpts
        );
      } catch (e) { console.error("[restart] relaunch error:", e.message); }
    }, 1000);
  }, 3000);

  res.json({ ok: true, message: `Restarting ${name}... will be ready in ~8s` });
});

// Start the full voz session
app.post("/api/start", async (_req, res) => {
  if (await sessionExists()) return res.json({ ok: true, message: "already running" });
  exec(wsl(`bash '${WSL_ORCH_DIR}/start.sh'`), { env: cleanEnv }, (err, stdout, stderr) => {
    if (err) return res.status(500).json({ error: stderr || err.message });
    cachedSession = null; // bust cache
    res.json({ ok: true, output: stdout });
  });
});

// Stop everything
app.post("/api/stop", (_req, res) => {
  exec(wsl(`bash '${WSL_ORCH_DIR}/stop.sh'`), { env: cleanEnv }, (err, stdout) => {
    cachedSession = null; // bust cache
    if (err) return res.json({ ok: true, message: "stop attempted" });
    res.json({ ok: true, output: stdout });
  });
});

// Memory sync
app.post("/api/memory/sync", (_req, res) => {
  exec(wsl(`bash '${WSL_ORCH_DIR}/sync.sh' sync`), { env: cleanEnv }, (err, stdout, stderr) => {
    if (err) return res.status(500).json({ error: stderr || err.message });
    res.json({ ok: true, output: stdout });
  });
});

// Memory push to remotes
app.post("/api/memory/push", (_req, res) => {
  exec(wsl(`bash '${WSL_ORCH_DIR}/sync.sh' push`), { env: cleanEnv }, (err, stdout, stderr) => {
    if (err) return res.status(500).json({ error: stderr || err.message });
    res.json({ ok: true, output: stdout });
  });
});

// Memory status
app.get("/api/memory/status", (_req, res) => {
  const projects = parseProjects();
  const result = projects.map((p) => {
    let memoryContent = null;
    let lines = 0;
    try {
      memoryContent = readFileSync(join(p.path.replace(/^\/mnt\/c\//, "C:\\\\").replace(/\//g, "\\\\"), "MEMORY.md"), "utf-8");
      lines = memoryContent.split("\n").filter(l => l.trim() && !l.startsWith("#") && !l.startsWith(">")).length;
    } catch {
      // Try direct path for Windows
      try {
        const winPath = p.path.replace(/^\/mnt\/c/, "/c");
        memoryContent = readFileSync(join(winPath, "MEMORY.md"), "utf-8");
        lines = memoryContent.split("\n").filter(l => l.trim() && !l.startsWith("#") && !l.startsWith(">")).length;
      } catch { /* no memory file */ }
    }
    return { name: p.name, hasMemory: memoryContent !== null, entries: lines, content: memoryContent };
  });
  res.json({ projects: result });
});

app.get("/api/health", async (_req, res) => {
  res.json({ ok: true, session: await sessionExists() });
});

// OpenAI proxy for auto-pilot
app.post("/api/openai/chat", async (req, res) => {
  const { apiKey, messages, model } = req.body;
  if (!apiKey) return res.status(400).json({ error: "apiKey required" });
  if (!messages) return res.status(400).json({ error: "messages required" });
  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: model || DEFAULT_OPENAI_MODEL,
        messages,
        max_tokens: 1024,
        temperature: 0.3,
      }),
    });
    const data = await r.json();
    if (data.error) return res.status(400).json({ error: data.error.message || data.error });
    const reply = data.choices?.[0]?.message?.content || "";
    res.json({ ok: true, reply });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Auto-pilot observability: observe -> classify -> decide -> log ---
//
// v1 ONLY observes and logs. Even a decision whose outcome is "answered" is
// not executed here; the policy ships disabled so that outcome is unreachable
// anyway. Wiring the actual send is a separate, later step gated on a
// reviewed, enabled policy and a human-approved suggested path.
const lastAsk = new Map(); // project -> last asking screen_hash (dedupe)
let observing = false;

async function observeOnce() {
  if (observing) return;
  if (!(await sessionExists())) return;
  observing = true;
  try {
    const projects = parseProjects().map((p) => p.name).filter((n) => n !== "voz");
    if (!projects.length) return;
    const panes = await captureAllPanes(projects, 120);
    for (const name of projects) {
      const raw = panes[name];
      if (raw == null) continue; // window not present

      let classified;
      try { classified = classify(raw); } catch { continue; }

      if (IDLE_WIDGETS.has(classified.widget_type)) {
        // Dispatched work finished: close the provenance context.
        eventlog.closeDispatchContext(name);
        lastAsk.delete(name);
        continue;
      }
      if (!ASKING_WIDGETS.has(classified.widget_type)) continue;

      // Diff-as-signal: only a new, distinct ask emits events. An identical
      // screen on the next poll is not a new fact.
      if (lastAsk.get(name) === classified.screen_hash) continue;
      lastAsk.set(name, classified.screen_hash);

      const prov = eventlog.resolveProvenance(name);

      // The ask is a fact about the worker.
      const asking = await eventlog.appendEvent(name, {
        type: "asking_state",
        widget_type: classified.widget_type,
        canonical_key: classified.canonical_key,
        safety_payload: classified.safety_payload,
        extracted_values: classified.extracted_values,
        signals: classified.signals,
        classifier_version: classified.classifier_version,
        screen_hash: classified.screen_hash,
        live_region_identified: classified.live_region_identified,
        provenance: prov.provenance,
        triggering_dispatch_id: prov.triggering_dispatch_id,
        raw_capture: raw, // stored for deterministic replay against new versions
      });

      // The decision is a distinct fact about Voz.
      const d = await decide({
        classified,
        provenance: prov.provenance,
        historyFn: (ck, p, win) =>
          eventlog.recentAnsweredDecisions(name, ck, p, win),
      });
      await eventlog.appendEvent(name, {
        type: "decision",
        asking_event_id: asking.id,
        triggering_dispatch_id: prov.triggering_dispatch_id,
        presence: { reachable: null }, // server has no presence signal yet
        ...d,
      });
    }
  } finally {
    observing = false;
  }
}
setInterval(observeOnce, 6000);

// Event log read for the dashboard timeline (the observability payoff).
app.get("/api/events/:project", async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 200, 1000);
  try {
    const events = await eventlog.readEvents(req.params.project, limit);
    res.json({ project: req.params.project, events });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Auto-sync memory every 5 minutes
setInterval(() => {
  exec(wsl(`bash '${WSL_ORCH_DIR}/sync.sh' sync`), { env: cleanEnv }, (err, stdout) => {
    if (!err && stdout.includes("committing")) {
      console.log(`[memory] Auto-synced: ${new Date().toISOString()}`);
    }
  });
}, 5 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`Voz dashboard running on http://localhost:${PORT}`);
});
