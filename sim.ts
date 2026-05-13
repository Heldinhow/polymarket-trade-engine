#!/usr/bin/env bun
/**
 * sim.ts — Run multiple crypto trading simulations in parallel via CLI
 *
 * Usage:
 *   bun sim.ts run --strategy <name> --rounds 10
 *   bun sim.ts start-batch --config <name> --rounds 10 [...]
 *   bun sim.ts list
 *   bun sim.ts result <runId>
 *   bun sim.ts compare
 *   bun sim.ts stop <runId>
 *   bun sim.ts delete <runId>
 *
 * Strategies:
 *   correlation-leader, near-resolution, momentum-continuation, mean-reversion,
 *   clob-momentum, spot-distance, time-weighted, day-hour-edge,
 *   fak-sniper, gtc-resting, synthetic-opposite, chunked-entries,
 *   dynamic-stop, timeout-exit,
 *   late-entry, two-sided-tp, eth-btc-correlation-tp, simulation
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from "fs";
import { join } from "path";
import { spawn } from "child_process";
import type { ChildProcess } from "child_process";

// ── State paths ────────────────────────────────────────────────────────────────

const SIM_STATE_DIR = "state/sim-runs";
mkdirSync(SIM_STATE_DIR, { recursive: true });

function simStatePath(runId: string) {
  return join(SIM_STATE_DIR, `sim-${runId}.json`);
}

// ── SimRun state ────────────────────────────────────────────────────────────────

type SimRun = {
  runId: string;
  createdAt: string;
  completedAt?: string;
  isCompleted: boolean;
  pid?: number;
  strategy: string;
  rounds: number;
  slotOffset: number;
  sessionPnl: number;
  sessionLoss: number;
  startingBalance: number;
  currentBalance: number;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  trades: SimTrade[];
  config: Record<string, string>;
};

type SimTrade = {
  slug: string;
  side: "UP" | "DOWN";
  entryPrice: number;
  exitPrice: number;
  shares: number;
  cost: number;
  pnl: number;
  result: "WIN" | "LOSS" | "OPEN";
  closedAt?: string;
};

// ── Strategy catalog ────────────────────────────────────────────────────────────

const STRATEGIES = [
  // Direction
  "correlation-leader",
  "near-resolution",
  "momentum-continuation",
  "mean-reversion",
  "clob-momentum",
  "spot-distance",
  "time-weighted",
  "day-hour-edge",
  // Execution
  "fak-sniper",
  "gtc-resting",
  "synthetic-opposite",
  "chunked-entries",
  // Risk
  "dynamic-stop",
  "timeout-exit",
  // Original
  "late-entry",
  "two-sided-tp",
  "eth-btc-correlation-tp",
  "simulation",
];

// ── Simulation runner ────────────────────────────────────────────────────────────

type SimOptions = {
  strategy: string;
  rounds: number;
  slotOffset?: number;
  startingBalance?: number;
  env?: Record<string, string>;
};

function startSimulation(opts: SimOptions): { runId: string; pid: number } {
  const runId = randomId(12);
  const stateFile = simStatePath(runId);

  // Write initial state
  const state: SimRun = {
    runId,
    createdAt: new Date().toISOString(),
    isCompleted: false,
    strategy: opts.strategy,
    rounds: opts.rounds,
    slotOffset: opts.slotOffset ?? 1,
    sessionPnl: 0,
    sessionLoss: 0,
    startingBalance: opts.startingBalance ?? 50,
    currentBalance: opts.startingBalance ?? 50,
    totalTrades: 0,
    winningTrades: 0,
    losingTrades: 0,
    trades: [],
    config: opts.env ?? {},
  };
  writeFileSync(stateFile, JSON.stringify(state, null, 2), "utf8");

  // Build args for main index.ts
  const args = [
    "index.ts",
    "--strategy", opts.strategy,
    "--slot-offset", String(opts.slotOffset ?? 1),
    "--rounds", String(opts.rounds),
  ];

  const childEnv = {
    ...process.env,
    SIM_RUN_ID: runId,
    SIM_STATE_FILE: stateFile,
    DRY_RUN_ENABLED: "true",
    WALLET_BALANCE: String(opts.startingBalance ?? 50),
    ...opts.env,
  };

  const child = spawn("bun", args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: childEnv,
    detached: true,
  });

  child.unref();

  // Update state with pid
  state.pid = child.pid;
  writeFileSync(stateFile, JSON.stringify(state, null, 2), "utf8");

  console.log(`[sim] Started ${runId} (pid ${child.pid}) strategy=${opts.strategy} rounds=${opts.rounds}`);

  return { runId, pid: child.pid! };
}

// ── State polling ────────────────────────────────────────────────────────────────

function pollRun(runId: string, intervalMs = 5000) {
  const interval = setInterval(() => {
    const state = loadStateSafe(runId);
    if (!state) { clearInterval(interval); return; }
    if (state.isCompleted) {
      clearInterval(interval);
      console.log(`\n[sim] Run ${runId} completed — P&L: ${state.sessionPnl >= 0 ? "+" : ""}${state.sessionPnl.toFixed(2)}`);
    }
  }, intervalMs);
}

// ── CLI ─────────────────────────────────────────────────────────────────────────

const subcommand = process.argv[2];

async function main() {
  switch (subcommand) {
    case "run": {
      const opts = parseRunArgs(process.argv.slice(3));
      validateStrategy(opts.strategy);
      const { runId, pid } = startSimulation(opts);
      pollRun(runId);
      break;
    }

    case "start-batch": {
      const batchArgs = parseBatchArgs(process.argv.slice(3));
      if (batchArgs.configs.length === 0) {
        console.error("No --config entries found. Example:");
        console.error("  bun sim.ts start-batch --config near-resolution --rounds 10 --config momentum-continuation --rounds 10");
        process.exit(1);
      }
      const pids: string[] = [];
      for (const cfg of batchArgs.configs) {
        validateStrategy(cfg.strategy);
        const { runId, pid } = startSimulation(cfg);
        pids.push(runId);
        await sleep(2500); // stagger 2.5s between starts
      }
      console.log(`\nStarted ${pids.length} simulations in parallel:`);
      for (const runId of pids) {
        const state = loadStateSafe(runId);
        console.log(`  ${runId}  ${state?.strategy}  ${state?.rounds} rounds  $${state?.startingBalance}`);
      }
      break;
    }

    case "list": {
      const runs = listSimRuns();
      if (runs.length === 0) {
        console.log("No simulations. Run 'bun sim.ts start-batch --config <strategy> --rounds 10' to start.");
        break;
      }
      console.log(`\nSimulations (${runs.length}):\n`);
      console.log("  RunId          Strategy              Round       Balance    P&L       Done");
      console.log("  ─────────────────────────────────────────────────────────────────────────────────");
      for (const r of runs) {
        const s = loadStateSafe(r.runId)!;
        if (!s) continue;
        const pnl = s.sessionPnl >= 0 ? `+${s.sessionPnl.toFixed(2)}` : s.sessionPnl.toFixed(2);
        const done = s.isCompleted ? "✓" : "○";
        const round = s.isCompleted ? `${s.rounds}/${s.rounds}` : `${s.trades.length}/${s.rounds}`;
        console.log(`  ${r.runId.padEnd(13)} ${(s.strategy || "?").padEnd(20)} ${String(round).padEnd(10)} $${(s.currentBalance ?? 0).toFixed(2).padStart(8)} ${(pnl as string).padStart(8)}   ${done}`);
      }
      console.log("");
      break;
    }

    case "result": {
      const runId = process.argv[3];
      if (!runId) { console.error("Usage: bun sim.ts result <runId>"); process.exit(1); }
      const state = loadStateSafe(runId);
      if (!state) { console.error(`Run '${runId}' not found.`); process.exit(1); }
      printRunResult(state);
      break;
    }

    case "compare": {
      const runs = listSimRuns().filter(r => {
        const s = loadStateSafe(r.runId);
        return s?.isCompleted;
      });
      if (runs.length === 0) { console.log("No completed runs to compare."); break; }
      console.log("\n  Strategy                Balance     P&L       Trades  WinRate");
      console.log("  ─────────────────────────────────────────────────────────────────");
      for (const r of runs) {
        const s = loadStateSafe(r.runId)!;
        const pnl = s.sessionPnl >= 0 ? `+$${s.sessionPnl.toFixed(2)}` : `-$${Math.abs(s.sessionPnl).toFixed(2)}`;
        const wr = s.totalTrades > 0 ? `${(s.winningTrades / s.totalTrades * 100).toFixed(0)}%` : "N/A";
        console.log(`  ${(s.strategy || "?").padEnd(21)} $${(s.currentBalance ?? 0).toFixed(2).padStart(8)} ${(pnl as string).padStart(10)}  ${String(s.totalTrades).padStart(6)}  ${wr.padStart(7)}`);
      }
      console.log("");
      break;
    }

    case "stop": {
      const runId = process.argv[3];
      if (!runId) { console.error("Usage: bun sim.ts stop <runId>"); process.exit(1); }
      stopRun(runId);
      break;
    }

    case "delete": {
      const runId = process.argv[3];
      if (!runId) { console.error("Usage: bun sim.ts delete <runId>"); process.exit(1); }
      deleteRun(runId);
      break;
    }

    case "strategies": {
      console.log("\nAvailable strategies:\n");
      console.log("  Direction strategies (choose UP/DOWN):");
      for (const s of STRATEGIES.slice(0, 8)) console.log(`    ${s.padEnd(22)}`);
      console.log("\n  Execution strategies (HOW to enter):");
      for (const s of STRATEGIES.slice(8, 12)) console.log(`    ${s.padEnd(22)}`);
      console.log("\n  Risk strategies (stop/exit management):");
      for (const s of STRATEGIES.slice(12)) console.log(`    ${s.padEnd(22)}`);
      console.log("\n  Original strategies:");
      for (const s of STRATEGIES.slice(14)) console.log(`    ${s.padEnd(22)}`);
      console.log("");
      break;
    }

    default: {
      console.log(`
Crypto Trading Simulation CLI — polymarket-trade-engine

Usage:
  bun sim.ts run --strategy <name> --rounds <n>      Start a single simulation
  bun sim.ts start-batch --config <name> ...          Start multiple in parallel
  bun sim.ts list                                       List all runs
  bun sim.ts result <runId>                             Detailed result
  bun sim.ts compare                                    Compare completed runs
  bun sim.ts stop <runId>                               Stop a running simulation
  bun sim.ts delete <runId>                             Delete a run
  bun sim.ts strategies                                 Show all strategies

Examples:
  # Single run
  bun sim.ts run --strategy near-resolution --rounds 20

  # Compare 4 strategies in parallel
  bun sim.ts start-batch \\
    --config near-resolution --rounds 15 \\
    --config momentum-continuation --rounds 15 \\
    --config mean-reversion --rounds 15 \\
    --config clob-momentum --rounds 15

  # With custom params via env
  NEAR_RESOLUTION_PRICE=0.98 bun sim.ts run --strategy near-resolution --rounds 20

Run 'bun sim.ts strategies' to see all available strategies.
`);
      process.exit(0);
    }
  }
}

main();

// ── Helpers ────────────────────────────────────────────────────────────────────

function loadStateSafe(runId: string): SimRun | null {
  try {
    const path = simStatePath(runId);
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8")) as SimRun;
  } catch { return null; }
}

function listSimRuns(): { runId: string; strategy: string; isCompleted: boolean }[] {
  if (!existsSync(SIM_STATE_DIR)) return [];
  return readdirSync(SIM_STATE_DIR)
    .filter(f => f.startsWith("sim-") && f.endsWith(".json"))
    .map(f => {
      try { const s = JSON.parse(readFileSync(join(SIM_STATE_DIR, f), "utf8")) as SimRun; return { runId: s.runId, strategy: s.strategy ?? "?", isCompleted: s.isCompleted }; }
      catch { return null; }
    })
    .filter(Boolean) as { runId: string; strategy: string; isCompleted: boolean }[];
}

function stopRun(runId: string): void {
  const state = loadStateSafe(runId);
  if (!state) { console.error(`Run '${runId}' not found.`); return; }
  if (state.pid) {
    try { process.kill(state.pid, "SIGTERM"); } catch { /* already dead */ }
  }
  state.isCompleted = true; state.completedAt = new Date().toISOString();
  writeFileSync(simStatePath(runId), JSON.stringify(state, null, 2));
  console.log(`Stop signal sent to ${runId}`);
}

function deleteRun(runId: string): void {
  const path = simStatePath(runId);
  if (existsSync(path)) unlinkSync(path);
  console.log(`Run '${runId}' deleted.`);
}

function validateStrategy(name: string): void {
  if (!STRATEGIES.includes(name)) {
    console.error(`Unknown strategy '${name}'. Run 'bun sim.ts strategies' for available strategies.`);
    process.exit(1);
  }
}

function printRunResult(state: SimRun): void {
  const pnl = state.sessionPnl;
  const pnlStr = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;
  const wr = state.totalTrades > 0 ? `${(state.winningTrades / state.totalTrades * 100).toFixed(0)}%` : "N/A";
  const status = state.isCompleted ? "✓ Completed" : "○ Running";

  console.log(`
╔══════════════════════════════════════════╗
║  ${`Sim Result: ${state.runId}`.padEnd(36)}║
╠══════════════════════════════════════════╣
║  Strategy      ${(state.strategy || "?").padEnd(27)}║
║  Status        ${status.padEnd(27)}║
║  Started        ${state.createdAt.slice(0, 25).padEnd(27)}║
║  Rounds         ${String(state.trades.length).padEnd(27)}║
║  Balance        $${String((state.currentBalance ?? 0).toFixed(2)).padEnd(26)}║
║  P&L            ${pnlStr.padEnd(27)}║
║  Win Rate       ${wr.padEnd(27)}║
╚══════════════════════════════════════════╝`);

  if (state.trades.length > 0) {
    console.log("\nRecent trades:");
    console.log("  Slug                    Side  Entry   Exit    P&L      Result");
    console.log("  ─────────────────────────────────────────────────────────────────");
    for (const t of state.trades.slice(-20)) {
      const p = t.pnl >= 0 ? `+${t.pnl.toFixed(2)}` : t.pnl.toFixed(2);
      console.log(`  ${(t.slug || "?").slice(0, 22).padEnd(22)} ${t.side.padEnd(5)} ${t.entryPrice.toFixed(4)}  ${t.exitPrice.toFixed(4)}  ${p.padStart(7)}  ${t.result}`);
    }
  }
}

function parseRunArgs(args: string[]): SimOptions {
  const opts: SimOptions = { strategy: "", rounds: 10, env: {} };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--strategy": case "-s": opts.strategy = args[++i]; break;
      case "--rounds": case "-r": opts.rounds = parseInt(args[++i], 10); break;
      case "--slot-offset": opts.slotOffset = parseInt(args[++i], 10); break;
      case "--starting-balance": opts.startingBalance = parseFloat(args[++i]); break;
      default:
        // Pass env vars through: KEY=value
        if (args[i].includes("=")) {
          const [k, v] = args[i].split("=");
          opts.env![k] = v;
        }
    }
  }
  if (!opts.strategy) {
    console.error("Error: --strategy is required");
    process.exit(1);
  }
  return opts;
}

type BatchConfig = SimOptions;
type BatchArgs = { configs: BatchConfig[] };

function parseBatchArgs(args: string[]): BatchArgs {
  const configs: BatchConfig[] = [];
  let i = 0;
  while (i < args.length) {
    if (args[i] === "--config") {
      i++;
      const cfg: SimOptions = { strategy: args[i++], rounds: 10, env: {} };
      while (i < args.length && !args[i].startsWith("--config") && !args[i].startsWith("-")) {
        switch (args[i]) {
          case "--strategy": case "-s": cfg.strategy = args[++i]; break;
          case "--rounds": case "-r": cfg.rounds = parseInt(args[++i], 10); break;
          case "--slot-offset": cfg.slotOffset = parseInt(args[++i], 10); break;
          case "--starting-balance": cfg.startingBalance = parseFloat(args[++i]); break;
          default:
            if (args[i].includes("=")) { const [k, v] = args[i].split("="); cfg.env![k] = v; }
        }
        i++;
      }
      configs.push(cfg);
    } else { i++; }
  }
  return { configs };
}

function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }

function randomId(len: number): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < len; i++) result += chars[Math.floor(Math.random() * chars.length)];
  return result;
}