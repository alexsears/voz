import express from "express";
import { execSync, exec } from "child_process";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

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

// --- Helpers ---
function wsl(cmd) {
  return `${WSL} bash -c "unset CLAUDECODE 2>/dev/null; ${cmd.replace(/"/g, '\\"')}"`;
}

const execOpts = { encoding: "utf-8", env: cleanEnv };

function sessionExists() {
  try {
    execSync(wsl(`tmux has-session -t ${SESSION} 2>/dev/null`), execOpts);
    return true;
  } catch {
    return false;
  }
}

function capturePane(windowName, lines = 40) {
  try {
    const raw = execSync(
      wsl(`tmux capture-pane -t ${SESSION}:${windowName} -p 2>/dev/null`),
      { ...execOpts, timeout: 5000 }
    );
    const allLines = raw.split("\n");
    return allLines.slice(-lines).join("\n");
  } catch {
    return null;
  }
}

function windowExists(name) {
  try {
    const out = execSync(
      wsl(`tmux list-windows -t ${SESSION} -F '#{window_name}' 2>/dev/null`),
      execOpts
    );
    return out.split("\n").map((l) => l.trim()).includes(name);
  } catch {
    return false;
  }
}

// --- Routes ---

// List projects from config
app.get("/api/projects", (_req, res) => {
  const projects = parseProjects();
  const active = sessionExists();
  const result = projects.map((p) => ({
    ...p,
    windowActive: active && windowExists(p.name),
  }));
  res.json({ session: active, projects: result });
});

// Get output from a project pane
app.get("/api/project/:name/output", (req, res) => {
  const lines = parseInt(req.query.lines) || 40;
  if (!sessionExists()) return res.json({ error: "session_not_running", output: null });
  const output = capturePane(req.params.name, lines);
  if (output === null) return res.json({ error: "window_not_found", output: null });
  res.json({ output });
});

// Get status of all projects
app.get("/api/status", (_req, res) => {
  if (!sessionExists()) return res.json({ session: false, projects: [] });
  const projects = parseProjects();
  const result = projects.map((p) => {
    const output = capturePane(p.name, 20);
    return { ...p, active: output !== null, output };
  });
  // Also get voz pane
  const orchOutput = capturePane("voz", 20);
  res.json({
    session: true,
    voz: { output: orchOutput },
    projects: result,
  });
});

// Dispatch a command to a project
app.post("/api/project/:name/dispatch", (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: "message required" });
  if (!sessionExists()) return res.status(503).json({ error: "session not running" });
  if (!windowExists(req.params.name))
    return res.status(404).json({ error: `window '${req.params.name}' not found` });

  try {
    const safeMsg = message.replace(/"/g, '\\"').replace(/'/g, "'\\''");
    execSync(
      wsl(`bash '${WSL_ORCH_DIR}/dispatch.sh' '${req.params.name}' '${safeMsg}'`),
      { ...execOpts, timeout: 10000 }
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Send Ctrl-C to a project
app.post("/api/project/:name/stop", (req, res) => {
  if (!sessionExists()) return res.status(503).json({ error: "session not running" });
  try {
    execSync(wsl(`tmux send-keys -t ${SESSION}:${req.params.name} C-c`), execOpts);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Send /exit to a project's Claude
app.post("/api/project/:name/exit", (req, res) => {
  if (!sessionExists()) return res.status(503).json({ error: "session not running" });
  try {
    execSync(wsl(`tmux send-keys -t ${SESSION}:${req.params.name} -l '/exit'`), execOpts);
    execSync(wsl(`tmux send-keys -t ${SESSION}:${req.params.name} Enter`), execOpts);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Start the full voz session
app.post("/api/start", (_req, res) => {
  if (sessionExists()) return res.json({ ok: true, message: "already running" });
  exec(wsl(`bash '${WSL_ORCH_DIR}/start.sh'`), { env: cleanEnv }, (err, stdout, stderr) => {
    if (err) return res.status(500).json({ error: stderr || err.message });
    res.json({ ok: true, output: stdout });
  });
});

// Stop everything
app.post("/api/stop", (_req, res) => {
  exec(wsl(`bash '${WSL_ORCH_DIR}/stop.sh'`), { env: cleanEnv }, (err, stdout) => {
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

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, session: sessionExists() });
});

// Serve static frontend
app.get("/", (_req, res) => {
  res.sendFile(join(__dirname, "index.html"));
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
