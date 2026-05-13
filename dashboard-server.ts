/**
 * dashboard-server.ts
 *
 * Serves:
 *   GET /                    → dashboard/index.html
 *   GET /api/sim-runs        → list all sim runs
 *   POST /api/sim/start-batch?strategies=x&rounds=20 → start batch sims
 *   POST /api/sim/stop/:id   → stop a run
 *   DELETE /api/sim/delete/:id → delete a run
 */
import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type { IncomingMessage, ServerResponse } from "http";
import { createServer } from "http";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.DASHBOARD_PORT ?? "3001", 10);
const SIM_STATE_DIR = join(__dirname, "state/sim-runs");

// ── HTTP Server ────────────────────────────────────────────────────────────────

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".ico": "image/x-icon",
};

function route(req: IncomingMessage, res: ServerResponse) {
  const url = req.url ?? "/";
  const pathname = url.split("?")[0];
  const method = req.method ?? "GET";

  try {
    if (pathname === "/api/sim-runs" && method === "GET") {
      return apiListRuns(res);
    }
    if (pathname.startsWith("/api/sim/start-batch") && method === "POST") {
      return apiStartBatch(req, res);
    }
    if (pathname.match(/^\/api\/sim\/stop\/([^/]+)$/) && method === "POST") {
      const runId = pathname.match(/^\/api\/sim\/stop\/([^/]+)$/)![1];
      return apiStopRun(runId, res);
    }
    if (pathname.match(/^\/api\/sim\/delete\/([^/]+)$/) && method === "DELETE") {
      const runId = pathname.match(/^\/api\/sim\/delete\/([^/]+)$/)![1];
      return apiDeleteRun(runId, res);
    }
    if (pathname === "/" || pathname === "/index.html") {
      return serveFile(join(__dirname, "dashboard", "index.html"), "text/html; charset=utf-8", res);
    }
    // Static files from dashboard/
    const filePath = join(__dirname, "dashboard", pathname);
    if (existsSync(filePath) && !filePath.includes("..")) {
      const ext = "." + pathname.split(".").pop()!;
      serveFile(filePath, MIME[ext] ?? "application/octet-stream", res);
    } else {
      res.writeHead(404);
      res.end("Not found");
    }
  } catch (err: any) {
    res.writeHead(500);
    res.end(`Server error: ${err.message}`);
  }
}

function serveFile(path: string, contentType: string, res: ServerResponse) {
  const data = readFileSync(path);
  res.writeHead(200, { "Content-Type": contentType });
  res.end(data);
}

// ── API Handlers ────────────────────────────────────────────────────────────────

function apiListRuns(res: ServerResponse) {
  if (!existsSync(SIM_STATE_DIR)) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("[]");
    return;
  }
  const files = readdirSync(SIM_STATE_DIR).filter(f => f.startsWith("sim-") && f.endsWith(".json"));
  const runs = files.map(f => {
    try {
      return JSON.parse(readFileSync(join(SIM_STATE_DIR, f), "utf8"));
    } catch { return null; }
  }).filter(Boolean);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(runs));
}

function apiStartBatch(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const strategies = url.searchParams.get("strategies") ?? "";
  const rounds = parseInt(url.searchParams.get("rounds") ?? "20", 10);
  const count = parseInt(url.searchParams.get("count") ?? "1", 10);

  const strategyList = strategies.split(",").map(s => s.trim()).filter(Boolean);
  const { spawn } = require("child_process");

  const launched: string[] = [];
  for (const strat of strategyList) {
    for (let i = 0; i < count; i++) {
      const runId = randomId(12);
      const stateFile = join(SIM_STATE_DIR, `sim-${runId}.json`);
      const state = {
        runId, createdAt: new Date().toISOString(), isCompleted: false, pid: null as number | null,
        strategy: strat, rounds, slotOffset: 1,
        sessionPnl: 0, sessionLoss: 0, startingBalance: 50,
        currentBalance: 50, totalTrades: 0, winningTrades: 0, losingTrades: 0,
        trades: [], config: {},
      };
      writeFileSync(stateFile, JSON.stringify(state, null, 2));
      const child = spawn("bun", ["index.ts", "--strategy", strat, "--slot-offset", "1", "--rounds", String(rounds)], {
        cwd: __dirname, stdio: "ignore", detached: true,
        env: { ...process.env, SIM_RUN_ID: runId, SIM_STATE_FILE: stateFile, DRY_RUN_ENABLED: "true" },
      });
      child.unref();
      launched.push(`${strat} → ${runId}`);
    }
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ launched: launched.length, runs: launched }));
}

function apiStopRun(runId: string, res: ServerResponse) {
  const path = join(SIM_STATE_DIR, `sim-${runId}.json`);
  if (existsSync(path)) {
    try {
      const state = JSON.parse(readFileSync(path, "utf8"));
      if (state.pid) {
        try { process.kill(state.pid, "SIGTERM"); } catch { /* */ }
      }
      state.isCompleted = true;
      state.completedAt = new Date().toISOString();
      writeFileSync(path, JSON.stringify(state, null, 2));
    } catch { /* */ }
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, runId }));
}

function apiDeleteRun(runId: string, res: ServerResponse) {
  const path = join(SIM_STATE_DIR, `sim-${runId}.json`);
  if (existsSync(path)) unlinkSync(path);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, runId }));
}

// ── Bootstrap ──────────────────────────────────────────────────────────────────

function randomId(len: number): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < len; i++) result += chars[Math.floor(Math.random() * chars.length)];
  return result;
}

const server = createServer(route);
server.listen(PORT, () => {
  console.log(`\n📊 PolySim Dashboard → http://localhost:${PORT}\n`);
});
