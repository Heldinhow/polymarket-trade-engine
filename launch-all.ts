/**
 * launch-all.ts — Launch all 18 strategies in parallel
 * Each run uses sim-engine.ts (not early-bird) so it works correctly in parallel.
 */
import { spawn } from "child_process";
import { mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";

const SIM_STATE_DIR = "state/sim-runs";
const LOG_DIR = "logs";
const ROUNDS = 20;

mkdirSync(SIM_STATE_DIR, { recursive: true });
mkdirSync(LOG_DIR, { recursive: true });

const STRATEGIES = [
  "correlation-leader", "near-resolution", "momentum-continuation",
  "mean-reversion", "clob-momentum", "spot-distance", "time-weighted", "day-hour-edge",
  "fak-sniper", "gtc-resting", "synthetic-opposite", "chunked-entries",
  "dynamic-stop", "timeout-exit",
  "late-entry", "two-sided-tp", "eth-btc-correlation-tp", "simulation",
];

function randomId(): string {
  return Math.random().toString(36).slice(2, 14);
}

const launched: { strategy: string; runId: string; pid: number }[] = [];
let delay = 0;

for (const strat of STRATEGIES) {
  const runId = randomId();
  const stateFile = join(SIM_STATE_DIR, `sim-${runId}.json`);
  const logFile = join(LOG_DIR, `sim-${runId}.log`);

  // Pre-create state in SimRun format
  const state = {
    runId, createdAt: new Date().toISOString(), isCompleted: false, pid: null as number | null,
    strategy: strat, rounds: ROUNDS, currentRound: 0, slotOffset: 1,
    sessionPnl: 0, sessionLoss: 0, startingBalance: 50, currentBalance: 50,
    totalTrades: 0, winningTrades: 0, losingTrades: 0, trades: [], config: {},
  };
  writeFileSync(stateFile, JSON.stringify(state, null, 2));

  setTimeout(() => {
    const child = spawn("bun", [
      "sim-engine.ts",
      "--strategy", strat,
      "--rounds", String(ROUNDS),
    ], {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      env: {
        ...process.env,
        SIM_RUN_ID: runId,
        SIM_STATE_FILE: stateFile,
        DRY_RUN_ENABLED: "true",
        MARKET_ASSET: "btc",
        MARKET_WINDOW: "5m",
      },
    });

    child.unref();

    // Update pid in state file
    const updated = { ...state, pid: child.pid ?? null };
    writeFileSync(stateFile, JSON.stringify(updated, null, 2));

    launched.push({ strategy: strat, runId, pid: child.pid ?? 0 });
    console.log(`✓ ${strat} → ${runId} (pid ${child.pid})`);
  }, delay);

  delay += 2000;
}

setTimeout(() => {
  console.log(`\n✅ Launched ${launched.length} strategies`);
  console.log(`   20 rounds × ~5min = ~100min total`);
  console.log(`\n📊 Dashboard: http://localhost:3001`);
  console.log(`📋 State: state/sim-runs/sim-{runId}.json`);
  console.log(`📝 Logs: logs/sim-{runId}.log\n`);
}, delay + 500);
