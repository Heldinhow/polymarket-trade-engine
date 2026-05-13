import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname, join } from "path";

export type SimRunState = {
  runId: string;
  createdAt: string;
  completedAt?: string;
  isCompleted: boolean;
  strategy: string;
  rounds: number;
  currentRound: number;
  // P&L
  sessionPnl: number;
  sessionLoss: number;
  startingBalance: number;
  currentBalance: number;
  // Stats
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  skippedSignals: number;
  // Trades log (last 100)
  recentTrades: SimTradeRecord[];
  // Daily P&L
  dailyPnls: DailyPnlRecord[];
  // Config
  config: SimConfig;
};

export type SimTradeRecord = {
  round: number;
  slug: string;
  side: "UP" | "DOWN";
  entryPrice: number;
  exitPrice: number;
  shares: number;
  cost: number;
  fee: number;
  pnl: number;
  result: "WIN" | "LOSS" | "PENDING";
  closedAt?: string;
};

export type DailyPnlRecord = {
  date: string;
  pnl: number;
  trades: number;
  wins: number;
};

export type SimConfig = {
  strategy: string;
  slotOffset: number;
  rounds: number; // total rounds to run
  dryRun: boolean;
  startingBalance: number;
  maxPositionSize: number;
  // Strategy-specific params
  minCorrelation?: number;
  maxEntryPrice?: number;
  stopLossPct?: number;
  takeProfitPct?: number;
  // Risk limits
  maxSessionLoss?: number;
  maxDrawdown?: number;
};

const STATE_DIR = "state/sim-runs";
const SAVE_INTERVAL_MS = 30_000;

// ── Persistence ────────────────────────────────────────────────────────────────

function statePath(runId: string): string {
  mkdirSync(STATE_DIR, { recursive: true });
  return join(STATE_DIR, `sim-${runId}.json`);
}

export function saveSimState(runId: string, state: SimRunState): void {
  const tmp = statePath(runId) + ".tmp";
  writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
  const { renameSync } = require("fs");
  renameSync(tmp, statePath(runId));
}

export function loadSimState(runId: string): SimRunState | null {
  try {
    const raw = readFileSync(statePath(runId), "utf8");
    return JSON.parse(raw) as SimRunState;
  } catch {
    return null;
  }
}

export function listSimRuns(): { runId: string; strategy: string; isCompleted: boolean; sessionPnl: number }[] {
  if (!existsSync(STATE_DIR)) return [];
  const { readdirSync } = require("fs");
  return readdirSync(STATE_DIR)
    .filter((f: string) => f.startsWith("sim-") && f.endsWith(".json"))
    .map((f: string) => {
      try {
        const raw = readFileSync(join(STATE_DIR, f), "utf8");
        const s = JSON.parse(raw) as SimRunState;
        return { runId: s.runId, strategy: s.strategy, isCompleted: s.isCompleted, sessionPnl: s.sessionPnl };
      } catch {
        return null;
      }
    })
    .filter(Boolean) as ReturnType<typeof listSimRuns>;
}

// ── Simulation Manager ─────────────────────────────────────────────────────────

import { EarlyBird } from "./early-bird.ts";
import { strategies } from "./strategy/index.ts";
import { acquireProcessLock, releaseProcessLock } from "../utils/process-lock.ts";

export type SimResult = {
  runId: string;
  success: boolean;
  error?: string;
  finalState: SimRunState;
};

/**
 * Runs a simulation for a given config.
 * Each run is independent: own state file, own balance tracking.
 * Runs in the current process (not forked).
 */
export async function runSimulation(config: SimConfig, onProgress?: (state: SimRunState) => void): Promise<SimResult> {
  const runId = randomId(12);
  const lockName = `sim-${runId}`;
  const stateFile = statePath(runId);

  mkdirSync(STATE_DIR, { recursive: true });

  // Initialize state
  const state: SimRunState = {
    runId,
    createdAt: new Date().toISOString(),
    strategy: config.strategy,
    rounds: config.rounds,
    currentRound: 0,
    sessionPnl: 0,
    sessionLoss: 0,
    startingBalance: config.startingBalance,
    currentBalance: config.startingBalance,
    totalTrades: 0,
    winningTrades: 0,
    losingTrades: 0,
    skippedSignals: 0,
    recentTrades: [],
    dailyPnls: [],
    config,
  };

  saveSimState(runId, state);
  let lastSave = Date.now();

  const result: SimResult = { runId, success: false, finalState: state };

  try {
    acquireProcessLock(lockName);

    // Run EarlyBird in dry-run mode for `rounds` market slots
    const bot = new EarlyBird(
      config.strategy,
      config_slotOffset,
      false, // not prod
      config.rounds,
      false, // not alwaysLog
    );

    // We need to intercept lifecycle events to update our state
    // Since EarlyBird runs the full lifecycle, we wrap with a proxy approach:
    // We'll hook into the tick loop via a modified state tracker

    let completedRounds = 0;

    // Monkey-patch the state save to also update our sim state
    const originalSaveState = (bot as any)._saveState?.bind(bot);

    // Intercept pnl updates
    const interval = setInterval(() => {
      // Read current state from early-bird's saved state
      const eaState = loadEarlyBirdState();
      if (eaState) {
        state.sessionPnl = eaState.sessionPnl ?? 0;
        state.sessionLoss = eaState.sessionLoss ?? 0;
        state.currentRound = completedRounds;
      }

      // Check risk limits
      const maxLoss = config.maxSessionLoss ?? 50;
      const maxDD = config.maxDrawdown ?? 50;
      if (Math.abs(state.sessionLoss) >= maxLoss || state.sessionPnl - Math.max(0, state.sessionPnl) <= -maxDD) {
        // Stop bot via shutdown
        (bot as any)._shuttingDown = true;
        for (const [, lc] of (bot as any)._lifecycles ?? new Map()) {
          lc.shutdown();
        }
      }

      // Persist sim state
      if (Date.now() - lastSave >= SAVE_INTERVAL_MS) {
        saveSimState(runId, state);
        lastSave = Date.now();
        onProgress?.(state);
      }
    }, 5000);

    // Start the bot (this blocks until all rounds complete or shutdown)
    await bot.start();

    completedRounds = (bot as any)._roundsCreated ?? 0;
    state.currentRound = completedRounds;
    state.isCompleted = true;
    state.completedAt = new Date().toISOString();

    clearInterval(interval);

    // Final state from early-bird
    const eaFinal = loadEarlyBirdState();
    if (eaFinal) {
      state.sessionPnl = eaFinal.sessionPnl ?? 0;
      state.sessionLoss = eaFinal.sessionLoss ?? 0;
      state.currentBalance = config.startingBalance + state.sessionPnl;

      // Merge completed markets into our trade log
      for (const market of eaFinal.completedMarkets ?? []) {
        for (const order of market.orderHistory ?? []) {
          const trade: SimTradeRecord = {
            round: state.totalTrades,
            slug: market.slug,
            side: order.action === "buy" ? "UP" : "DOWN", // approximation
            entryPrice: order.price,
            exitPrice: 0,
            shares: order.shares,
            cost: order.action === "buy" ? order.price * order.shares : 0,
            fee: order.fee ?? 0,
            pnl: 0,
            result: "WIN", // need resolution data
          };
          state.recentTrades.push(trade);
          state.totalTrades++;
        }
      }
    }

    saveSimState(runId, state);
    result.success = true;
    result.finalState = state;

  } catch (err: any) {
    result.success = false;
    result.error = err.message;
    state.isCompleted = true;
    state.completedAt = new Date().toISOString();
    saveSimState(runId, state);
    result.finalState = state;
  } finally {
    releaseProcessLock(lockName);
  }

  return result;
}

function loadEarlyBirdState(): any {
  try {
    const path = "state/early-bird.json";
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function randomId(len: number): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < len; i++) result += chars[Math.floor(Math.random() * chars.length)];
  return result;
}

function config_slotOffset(config: SimConfig): number {
  return config.slotOffset ?? 1;
}