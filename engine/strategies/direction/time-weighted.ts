/**
 * 7. Time-Weighted Signal
 *
 * Dá mais peso para movimentos recentes.
 * Pondera aceleração recente, últimos segundos, intensidade temporal.
 *
 * Example:
 *   Últimos 20s: explosão de compra
 *   => aumenta score de UP
 */
import type { Strategy, StrategyContext } from "../types.ts";
import { Env } from "../../utils/config.ts";

type TimeWeightedConfig = {
  enabled: boolean;
  shortWindowSecs: number;          // recent window (e.g. 20s)
  longWindowSecs: number;            // baseline window (e.g. 120s)
  accelerationThreshold: number;     // min acceleration to trigger
  maxEntryPrice: number;
  stopLossPct: number;
  takeProfitPct: number;
};

function loadConfig(): TimeWeightedConfig {
  return {
    enabled: Env.get("ENABLE_TIME_WEIGHTED_STRATEGY") !== "false",
    shortWindowSecs: parseInt(Env.get("TIME_WEIGHTED_SHORT_WINDOW") ?? "20", 10),
    longWindowSecs: parseInt(Env.get("TIME_WEIGHTED_LONG_WINDOW") ?? "120", 10),
    accelerationThreshold: parseFloat(Env.get("TIME_WEIGHTED_ACCELERATION_THRESHOLD") ?? "0.05"),
    maxEntryPrice: parseFloat(Env.get("TIME_WEIGHTED_MAX_ENTRY_PRICE") ?? "0.45"),
    stopLossPct: parseFloat(Env.get("TIME_WEIGHTED_STOP_LOSS_PCT") ?? "0.35"),
    takeProfitPct: parseFloat(Env.get("TIME_WEIGHTED_TAKE_PROFIT_PCT") ?? "0.5"),
  };
}

type PriceSample = { price: number; ts: number };
type State = { entered: boolean; enteredSide: "UP" | "DOWN" | null; enteredAtPrice: number; shares: number };

const DEFAULT_SHARES = 6;

export const timeWeighted: Strategy = async (ctx) => {
  if (!Env.get("DRY_RUN_ENABLED")) { ctx.log("[time-weighted] DRY_RUN_REQUIRED", "red"); process.exit(1); }
  const cfg = loadConfig();
  if (!cfg.enabled) { ctx.log("[time-weighted] disabled", "dim"); return; }

  const release = ctx.hold();
  const state: State = { entered: false, enteredSide: null, enteredAtPrice: 0, shares: 0 };
  const priceSamples: PriceSample[] = [];

  const log = (msg: string, color: "cyan" | "green" | "yellow" | "red" | "dim" = "cyan") =>
    ctx.log(`[time-weighted] ${msg}`, color);

  const computeScore = (): { side: "UP" | "DOWN"; score: number } | null => {
    if (priceSamples.length < 10) return null;
    const now = Date.now();
    const shortCutoff = now - cfg.shortWindowSecs * 1000;
    const longCutoff = now - cfg.longWindowSecs * 1000;

    const recentSamples = priceSamples.filter(s => s.ts >= shortCutoff);
    const longSamples = priceSamples.filter(s => s.ts >= longCutoff);

    if (recentSamples.length < 3 || longSamples.length < 5) return null;

    const recentChange = recentSamples[recentSamples.length - 1].price - recentSamples[0].price;
    const longChange = longSamples[longSamples.length - 1].price - longSamples[0].price;

    // Acceleration: recent change >> long change → momentum increasing
    const acceleration = recentChange - (longChange * (cfg.shortWindowSecs / cfg.longWindowSecs));

    if (Math.abs(acceleration) < cfg.accelerationThreshold) return null;
    return { side: acceleration > 0 ? "UP" : "DOWN", score: Math.abs(acceleration) };
  };

  const interval = setInterval(() => {
    const remaining = Math.floor((ctx.slotEndMs - Date.now()) / 1000);
    if (remaining <= 0) { clearInterval(interval); release(); return; }

    const price = ctx.ticker.price;
    if (price !== undefined) {
      priceSamples.push({ price, ts: Date.now() });
      const cutoff = Date.now() - cfg.longWindowSecs * 1000 * 2;
      while (priceSamples.length > 0 && priceSamples[0].ts < cutoff) priceSamples.shift();
    }

    if (!state.entered) {
      const score = computeScore();
      if (!score) return;

      const upAsk = ctx.orderBook.bestAskInfo("UP");
      const downAsk = ctx.orderBook.bestAskInfo("DOWN");
      if (!upAsk || !downAsk) return;

      const entryPrice = score.side === "UP" ? upAsk.price : downAsk.price;
      if (entryPrice > cfg.maxEntryPrice) { log(`price too high ${entryPrice.toFixed(3)}`, "dim"); return; }

      log(`signal: ${score.side} acceleration=${score.score.toFixed(4)} → @ ${entryPrice.toFixed(4)}`, "cyan");
      placeBuy(ctx, state, score.side, entryPrice, log, () => { clearInterval(interval); release(); });
    } else {
      const posSide = state.enteredSide!;
      const currentAsk = ctx.orderBook.bestAskInfo(posSide)?.price ?? 0;
      if (currentAsk === 0) return;
      const pnlPct = ((currentAsk - state.enteredAtPrice) / state.enteredAtPrice) * (posSide === "UP" ? 1 : -1);
      if (pnlPct >= cfg.takeProfitPct) {
        const bestBid = ctx.orderBook.bestBidPrice(posSide) ?? currentAsk - 0.01;
        placeSell(ctx, state, bestBid, log, () => { clearInterval(interval); release(); });
      } else if (pnlPct <= -cfg.stopLossPct) {
        const bestBid = ctx.orderBook.bestBidPrice(posSide) ?? currentAsk - 0.01;
        placeSell(ctx, state, bestBid, log, () => { clearInterval(interval); release(); });
      } else if (remaining <= 5) {
        const bestBid = ctx.orderBook.bestBidPrice(posSide) ?? currentAsk;
        placeSell(ctx, state, bestBid, log, () => { clearInterval(interval); release(); });
      }
    }
  }, 200);

  return () => clearInterval(interval);
};

function placeBuy(ctx: StrategyContext, state: State, side: "UP" | "DOWN", price: number,
  log: (msg: string, color?: "cyan" | "green" | "yellow" | "red" | "dim") => void, onDone: () => void) {
  const tokenId = side === "UP" ? ctx.clobTokenIds[0] : ctx.clobTokenIds[1];
  state.entered = true; state.enteredSide = side; state.enteredAtPrice = price; state.shares = DEFAULT_SHARES;
  ctx.postOrders([{ req: { tokenId, action: "buy", price, shares: DEFAULT_SHARES }, expireAtMs: ctx.slotEndMs,
    onFilled(filledShares) { log(`BUY ${side} @ ${price} filled (${filledShares})`, "green"); },
    onExpired() { log("entry expired", "yellow"); state.entered = false; onDone(); },
    onFailed(r) { log(`entry failed: ${r}`, "red"); state.entered = false; onDone(); },
  }]);
}

function placeSell(ctx: StrategyContext, state: State, price: number,
  log: (msg: string, color?: "cyan" | "green" | "yellow" | "red" | "dim") => void, onDone: () => void) {
  const posSide = state.enteredSide!;
  const tokenId = posSide === "UP" ? ctx.clobTokenIds[0] : ctx.clobTokenIds[1];
  ctx.postOrders([{ req: { tokenId, action: "sell", price, shares: state.shares }, expireAtMs: ctx.slotEndMs,
    onFilled() { log(`SELL ${posSide} @ ${price} filled`, "green"); state.entered = false; onDone(); },
    onExpired() { log("sell expired", "red"); ctx.emergencySells(ctx.pendingOrders.filter(o => o.action === "sell").map(o => o.orderId)); state.entered = false; onDone(); },
  }]);
}

export default timeWeighted;