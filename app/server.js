import express from "express";
import { exec } from "child_process";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { promisify } from "util";

const execAsync = promisify(exec);

const __dirname = dirname(fileURLToPath(import.meta.url));
const ORCH_DIR = join(__dirname, "..");
const CONFIG = join(ORCH_DIR, "projects.yaml");
const SESSION = "voz";
const PORT = process.env.PORT || 4800;
const WSL = "wsl -d Ubuntu --";

// Clean env: strip CLAUDECODE so child processes don't think they're nested
const cleanEnv = { ...process.env };
delete cleanEnv.CLAUDECODE;

// Convert Windows path to WSL path
function toWslPath(winPath) {
  return winPath.replace(/^([A-Za-z]):/, (_, d) => `/mnt/${d.toLowerCase()}`).replace(/\\/g, "/");
}
const WSL_ORCH_DIR = toWslPath(ORCH_DIR);

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
function wsl(cmd) {
  return `${WSL} bash -c "unset CLAUDECODE 2>/dev/null; ${cmd.replace(/"/g, '\\"')}"`;
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
      wsl(`tmux capture-pane -t ${SESSION}:${windowName} -p 2>/dev/null`),
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
    name => `echo "___PANE_${name}___"; tmux capture-pane -t ${SESSION}:${name} -p 2>/dev/null || echo "___NOWINDOW___"`
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
  const launchKeys = `/mnt/c/Windows/System32/cmd.exe /c "set CLAUDECODE= && C:\\\\Users\\\\asear\\\\.local\\\\bin\\\\claude.exe --dangerously-skip-permissions"`;

  setTimeout(async () => {
    try { await wslExec(`tmux send-keys -t ${SESSION}:${name} C-c`); } catch {}
    setTimeout(async () => {
      try {
        // Send the launch command character-by-character via -l, then Enter
        await execAsync(
          `wsl -d Ubuntu -- tmux send-keys -t ${SESSION}:${name} -l '${launchKeys}'`,
          execOpts
        );
        await execAsync(
          `wsl -d Ubuntu -- tmux send-keys -t ${SESSION}:${name} Enter`,
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
        model: model || "gpt-4o",
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
