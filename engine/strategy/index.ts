import type { Strategy } from "./types.ts";
import { simulationStrategy } from "./simulation.ts";
import { lateEntry } from "./late-entry.ts";
import { twoSidedTp } from "./two-sided-tp.ts";
import { ethBtcCorrelationTp } from "./eth-btc-correlation-tp.ts";

// Direction strategies
import { correlationLeader } from "./strategies/direction/correlation-leader.ts";
import { nearResolution } from "./strategies/direction/near-resolution.ts";
import { momentumContinuation } from "./strategies/direction/momentum-continuation.ts";
import { meanReversion } from "./strategies/direction/mean-reversion.ts";
import { clobMomentum } from "./strategies/direction/clob-momentum.ts";
import { spotDistance } from "./strategies/direction/spot-distance.ts";
import { timeWeighted } from "./strategies/direction/time-weighted.ts";
import { dayHourEdge } from "./strategies/direction/day-hour-edge.ts";

// Execution strategies
import { fakSniper } from "./strategies/execution/fak-sniper.ts";
import { gtcResting } from "./strategies/execution/gtc-resting.ts";
import { syntheticOpposite } from "./strategies/execution/synthetic-opposite.ts";
import { chunkedEntries } from "./strategies/execution/chunked-entries.ts";

// Risk strategies
import { dynamicStop } from "./strategies/risk/dynamic-stop.ts";
import { timeoutExit } from "./strategies/risk/timeout-exit.ts";

export const strategies: Record<string, Strategy> = {
  // ── Original ───────────────────────────────────────────────────────────────
  "simulation": simulationStrategy,
  "late-entry": lateEntry,
  "two-sided-tp": twoSidedTp,
  "eth-btc-correlation-tp": ethBtcCorrelationTp,

  // ── Direction strategies ──────────────────────────────────────────────────
  /** 1. Correlation Leader: BTC leads → ETH/SOL follow with delay */
  "correlation-leader": correlationLeader,
  /** 2. Near Resolution 99c: ride or fade spike near resolution */
  "near-resolution": nearResolution,
  /** 3. Momentum Continuation: trend following on consecutive candles */
  "momentum-continuation": momentumContinuation,
  /** 4. Mean Reversion: fade spike / fake move */
  "mean-reversion": meanReversion,
  /** 5. CLOB Momentum: order book imbalance + velocity */
  "clob-momentum": clobMomentum,
  /** 6. Spot Distance from Strike: spot vs market strike mismatch */
  "spot-distance": spotDistance,
  /** 7. Time-Weighted Signal: acceleration-weighted momentum */
  "time-weighted": timeWeighted,
  /** 8. Day/Hour Edge: hourly + day-of-week patterns */
  "day-hour-edge": dayHourEdge,

  // ── Execution strategies ─────────────────────────────────────────────────
  /** 9. FAK Sniper: fill-and-kill speed execution */
  "fak-sniper": fakSniper,
  /** 10. GTC Resting Limit: maker order resting at mid+offset */
  "gtc-resting": gtcResting,
  /** 11. Synthetic Opposite: sell the opposite side for better liquidity */
  "synthetic-opposite": syntheticOpposite,
  /** 12. Chunked Entries: DCA into position in pieces */
  "chunked-entries": chunkedEntries,

  // ── Risk strategies ───────────────────────────────────────────────────────
  /** 13. Dynamic Stop Loss: ATR + momentum-adjusted stop */
  "dynamic-stop": dynamicStop,
  /** 14. Timeout Exit: exit N seconds before close to avoid chaos */
  "timeout-exit": timeoutExit,
};

export const DEFAULT_STRATEGY = "simulation";

export type { Strategy, StrategyContext } from "./types.ts";
