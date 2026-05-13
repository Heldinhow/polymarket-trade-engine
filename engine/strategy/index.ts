import type { Strategy } from "./types.ts";
import { simulationStrategy } from "./simulation.ts";
import { lateEntry } from "./late-entry.ts";
import { twoSidedTp } from "./two-sided-tp.ts";
import { ethBtcCorrelationTp } from "./eth-btc-correlation-tp.ts";

// Direction strategies
import { correlationLeader } from "../strategies/direction/correlation-leader.ts";
import { nearResolution } from "../strategies/direction/near-resolution.ts";
import { momentumContinuation } from "../strategies/direction/momentum-continuation.ts";
import { meanReversion } from "../strategies/direction/mean-reversion.ts";
import { clobMomentum } from "../strategies/direction/clob-momentum.ts";
import { spotDistance } from "../strategies/direction/spot-distance.ts";
import { timeWeighted } from "../strategies/direction/time-weighted.ts";
import { dayHourEdge } from "../strategies/direction/day-hour-edge.ts";

// Execution strategies
import { fakSniper } from "../strategies/execution/fak-sniper.ts";
import { gtcResting } from "../strategies/execution/gtc-resting.ts";
import { syntheticOpposite } from "../strategies/execution/synthetic-opposite.ts";
import { chunkedEntries } from "../strategies/execution/chunked-entries.ts";

// Risk strategies
import { dynamicStop } from "../strategies/risk/dynamic-stop.ts";
import { timeoutExit } from "../strategies/risk/timeout-exit.ts";

export const strategies: Record<string, Strategy> = {
  "simulation": simulationStrategy,
  "late-entry": lateEntry,
  "two-sided-tp": twoSidedTp,
  "eth-btc-correlation-tp": ethBtcCorrelationTp,

  // Direction strategies
  "correlation-leader": correlationLeader,
  "near-resolution": nearResolution,
  "momentum-continuation": momentumContinuation,
  "mean-reversion": meanReversion,
  "clob-momentum": clobMomentum,
  "spot-distance": spotDistance,
  "time-weighted": timeWeighted,
  "day-hour-edge": dayHourEdge,

  // Execution strategies
  "fak-sniper": fakSniper,
  "gtc-resting": gtcResting,
  "synthetic-opposite": syntheticOpposite,
  "chunked-entries": chunkedEntries,

  // Risk strategies
  "dynamic-stop": dynamicStop,
  "timeout-exit": timeoutExit,
};

export const DEFAULT_STRATEGY = "simulation";

export type { Strategy, StrategyContext } from "./types.ts";
