#!/usr/bin/env bun
/**
 * sim.ts — Run multiple crypto trading simulations in parallel via CLI
 *
 * Usage:
 *   bun sim.ts run --strategy late-entry --rounds 10 --dry-run
 *   bun sim.ts run --strategy two-sided-tp --rounds 20 --dry-run
 *   bun sim.ts list
 *   bun sim.ts result <runId>
 *   bun sim.ts delete <runId>
 *   bun sim.ts compare
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import { spawn } from "child_process";
import type { ChildProcess } from "child_process";

// ── State paths ────────────────────────────────────────────────────────────────

const SIM_STATE_DIR = "state/sim-runs";
const EARLY_BIRD_STATE = "state/early-bird.json";

mkdirSync(SIM_STATE_DIR, { recursive: true });

function simStatePath(runId: string) {
  return join(SIM_STATE_DIR, `sim-${runId}.json`);
}

// ── SimRun state ──────────────────────────────────────────────────────────────

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

// ── Simulation runner ──────────────────────────────────────────────────────────

type SimOptions = {
  strategy: string;
  rounds: number;
  slotOffset?: number;
  startingBalance?: number;
  minCorrelation?: number;
  maxEntryPrice?: number;
  dryRun?: boolean;
};

function startSimulation(opts: SimOptions): { runId: string; pid: number } {
  const runId = randomId(12);
  const stateFile = `state/sim-runs/${runId}.json`;

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
  };
  writeFileSync(stateFile, JSON.stringify(state, null, 2), "utf8");

  // Build args for main index.ts
  const args = [
    "index.ts",
    "--strategy", opts.strategy,
    "--slot-offset", String(opts.slotOffset ?? 1),
    "--rounds", String(opts.rounds),
    "--dry-run",
  ];

  const env = {
    ...process.env,
    SIM_RUN_ID: runId,
    SIM_STATE_FILE: stateFile,
    DRY_RUN_ENABLED: "true",
    WALLET_BALANCE: String(opts.startingBalance ?? 50),
    // Strategy-specific overrides
    ...(opts.minCorrelation !== undefined ? { CORRELATION_MIN_CORRELATION: String(opts.minCorrelation) } : {}),
    ...(opts.maxEntryPrice !== undefined ? { CORRELATION_MAX_ENTRY_PRICE: String(opts.maxEntryPrice) } : {}),
  };

  const child = spawn("bun", args, {
    stdio: ["ignore", "pipe", "pipe"],
    env,
    detached: true,
  });

  child.unref(); // let parent exit

  console.log(`[sim] Started run ${runId} (pid ${child.pid}) strategy=${opts.strategy} rounds=${opts.rounds}`);

  return { runId, pid: child.pid! };
}

// ── CLI ─────────────────────────────────────────────────────────────────────────

const subcommand = process.argv[2];

async function main() {
  switch (subcommand) {
    case "run": {
      const opts = parseRunArgs(process.argv.slice(3));
      const { runId, pid } = startSimulation(opts);
      console.log(`Run ${runId} started (pid ${pid})`);
      break;
    }

    case "start-batch": {
      const batchArgs = parseBatchArgs(process.argv.slice(3));
      const pids: string[] = [];

      for (const cfg of batchArgs.configs) {
        const { runId, pid } = startSimulation(cfg);
        pids.push(runId);
        // Stagger starts by 2s to avoid same-slot collisions
        await sleep(2000);
      }

      console.log(`\nStarted ${pids.length} simulations in parallel:`);
      for (const runId of pids) {
        const state = loadStateSafe(runId);
        console.log(`  ${runId}  strategy=${state?.strategy ?? "?"}  balance=${state?.startingBalance ?? "?"}`);
      }
      break;
    }

    case "list": {
      const runs = listSimRuns();
      if (runs.length === 0) {
        console.log("No simulations found. Run 'bun sim.ts start-batch ...' to start one.");
        break;
      }
      console.log(`\nSimulations (${runs.length}):\n`);
      console.log("  RunId          Strategy         Round  Balance   P&L       Done  PID");
      console.log("  ──────────────────────────────────────────────────────────────────────────");
      for (const r of runs) {
        const state = loadStateSafe(r.runId);
        if (!state) continue;
        const pnl = state.sessionPnl >= 0 ? `+${state.sessionPnl.toFixed(2)}` : state.sessionPnl.toFixed(2);
        const done = state.isCompleted ? "✓" : "○";
        const pid = state.pid ?? "-";
        const round = state.isCompleted
          ? `${state.rounds}/${state.rounds}`
          : `${state.trades.length}/${state.rounds}`;
        console.log(`  ${r.runId.padEnd(13)} ${(state.strategy || "?").padEnd(15)} ${String(round).padEnd(6)} ${(state.currentBalance ?? 0).toFixed(2).padStart(8)} ${(pnl as string).padStart(8)}   ${done}    ${pid}`);
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
      const runs = listSimRuns().filter(r => loadStateSafe(r.runId)?.isCompleted);
      if (runs.length === 0) { console.log("No completed runs to compare."); break; }
      console.log("\n  Strategy             Balance   P&L      Trades  WinRate");
      console.log("  ─────────────────────────────────────────────────────────────");
      for (const r of runs) {
        const s = loadStateSafe(r.runId)!;
        const pnl = s.sessionPnl >= 0 ? `+${s.sessionPnl.toFixed(2)}` : s.sessionPnl.toFixed(2);
        const wr = s.totalTrades > 0 ? `${(s.winningTrades / s.totalTrades * 100).toFixed(0)}%` : "N/A";
        console.log(`  ${(s.strategy || "?").padEnd(18)} ${(s.currentBalance ?? 0).toFixed(2).padStart(8)} ${(pnl as string).padStart(8)}  ${String(s.totalTrades).padStart(6)}  ${wr.padStart(7)}`);
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

    default: {
      console.log(`
Crypto Trading Simulation CLI — polymarket-trade-engine

Usage:
  bun sim.ts run --strategy <name> --rounds <n>     Start a single simulation
  bun sim.ts start-batch <configs...>                Start multiple simulations in parallel
  bun sim.ts list                                    List all runs
  bun sim.ts result <runId>                          Show detailed result
  bun sim.ts compare                                 Compare completed runs
  bun sim.ts stop <runId>                           Stop a running simulation
  bun sim.ts delete <runId>                          Delete a run and its state

Strategies available:
  late-entry, two-sided-tp, eth-btc-correlation-tp,
  contrary-move, contrary-tp, btc-correlated,
  simulation, momentum, mean-reversion

Examples:
  bun sim.ts run --strategy late-entry --rounds 10
  bun sim.ts start-batch \\
    --config edge-only --rounds 10 \\
    --config two-sided-tp --rounds 10 \\
    --config btc-correlated --rounds 10
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
  } catch {
    return null;
  }
}

function listSimRuns(): { runId: string; strategy: string; isCompleted: boolean }[] {
  if (!existsSync(SIM_STATE_DIR)) return [];
  return readdirSync(SIM_STATE_DIR)
    .filter(f => f.startsWith("sim-") && f.endsWith(".json"))
    .map(f => {
      try {
        const s = JSON.parse(readFileSync(join(SIM_STATE_DIR, f), "utf8")) as SimRun;
        return { runId: s.runId, strategy: s.strategy ?? "?", isCompleted: s.isCompleted };
      } catch {
        return null;
      }
    })
    .filter(Boolean) as { runId: string; strategy: string; isCompleted: boolean }[];
}

function stopRun(runId: string): void {
  const state = loadStateSafe(runId);
  if (!state) { console.error(`Run '${runId}' not found.`); return; }
  if (state.pid) {
    try { process.kill(state.pid, "SIGTERM"); } catch { /* already dead */ }
  }
  console.log(`Stop signal sent to run ${runId}`);
}

function deleteRun(runId: string): void {
  const path = simStatePath(runId);
  if (existsSync(path)) unlinkSync(path);
  console.log(`Run '${runId}' deleted.`);
}

function printRunResult(state: SimRun): void {
  const pnl = state.sessionPnl;
  const pnlStr = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;
  const wr = state.totalTrades > 0 ? `${(state.winningTrades / state.totalTrades * 100).toFixed(0)}%` : "N/A";

  console.log(`
╔═══════════════════════════════════════╗
║          Sim Result: ${state.runId.padEnd(18)}║
╠═══════════════════════════════════════╣
║  Strategy      ${(state.strategy || "?").padEnd(25)}║
║  Status        ${(state.isCompleted ? "Completed" : "Running").padEnd(25)}║
║  Started        ${(state.createdAt || "?").slice(0, 25).padEnd(25)}║
║  Rounds         ${String(state.rounds).padEnd(25)}║
║  Balance        $${String((state.currentBalance ?? 0).toFixed(2)).padEnd(24)}║
║  P&L            ${pnlStr.padEnd(25)}║
║  Win Rate       ${wr.padEnd(25)}║
╚═══════════════════════════════════════╝`);

  if (state.trades.length > 0) {
    console.log("\nRecent trades:");
    console.log("  Slug                    Side  Entry   Exit    P&L     Result");
    console.log("  ─────────────────────────────────────────────────────────────────");
    for (const t of state.trades.slice(-20)) {
      const p = t.pnl >= 0 ? `+${t.pnl.toFixed(2)}` : t.pnl.toFixed(2);
      console.log(`  ${(t.slug || "?").slice(0, 22).padEnd(22)} ${t.side.padEnd(5)} ${t.entryPrice.toFixed(4)}  ${t.exitPrice.toFixed(4)}  ${p.padStart(7)}  ${t.result}`);
    }
  }
}

function parseRunArgs(args: string[]): SimOptions {
  const opts: SimOptions = { strategy: "", rounds: 10 };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--strategy": case "-s": opts.strategy = args[++i]; break;
      case "--rounds": case "-r": opts.rounds = parseInt(args[++i], 10); break;
      case "--slot-offset": opts.slotOffset = parseInt(args[++i], 10); break;
      case "--starting-balance": opts.startingBalance = parseFloat(args[++i]); break;
      case "--dry-run": opts.dryRun = true; break;
      case "--min-correlation": opts.minCorrelation = parseFloat(args[++i]); break;
      case "--max-entry-price": opts.maxEntryPrice = parseFloat(args[++i]); break;
    }
  }
  if (!opts.strategy) { console.error("Error: --strategy is required"); process.exit(1); }
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
      const cfg: SimOptions = { strategy: args[i++], rounds: 10 };
      while (i < args.length && !args[i].startsWith("--config")) {
        switch (args[i]) {
          case "--strategy": case "-s": cfg.strategy = args[++i]; break;
          case "--rounds": case "-r": cfg.rounds = parseInt(args[++i], 10); break;
          case "--slot-offset": cfg.slotOffset = parseInt(args[++i], 10); break;
          case "--starting-balance": cfg.startingBalance = parseFloat(args[++i]); break;
        }
        i++;
      }
      configs.push(cfg);
    } else {
      i++;
    }
  }
  return { configs };
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function randomId(len: number): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < len; i++) result += chars[Math.floor(Math.random() * chars.length)];
  return result;
}