/**
 * 3. Momentum Continuation
 *
 * Trend following curto prazo.
 * Entrada quando várias candles na mesma direção + momentum crescente.
 *
 * Example:
 *   BTC: 4 candles verdes seguidos
 *   => compra UP
 */
import type { Strategy, StrategyContext } from "../types.ts";
import { Env } from "../../../utils/config.ts";

type MomentumConfig = {
  enabled: boolean;
  lookbackWindows: number;           // number of price windows to check
  minConsecutiveDirection: number;   // e.g. 3
  minPriceChangePct: number;         // e.g. 0.1 (0.1%)
  minVolume: number;
  maxEntryPrice: number;             // don't enter above this
  stopLossPct: number;
  takeProfitPct: number;
};

function loadConfig(): MomentumConfig {
  return {
    enabled: Env.get("ENABLE_MOMENTUM_STRATEGY") !== "false",
    lookbackWindows: parseInt(Env.get("MOMENTUM_LOOKBACK_WINDOWS") ?? "5", 10),
    minConsecutiveDirection: parseInt(Env.get("MOMENTUM_MIN_CONSECUTIVE_DIRECTION") ?? "3", 10),
    minPriceChangePct: parseFloat(Env.get("MOMENTUM_MIN_PRICE_CHANGE_PCT") ?? "0.1"),
    minVolume: parseFloat(Env.get("MOMENTUM_MIN_VOLUME") ?? "0"),
    maxEntryPrice: parseFloat(Env.get("MOMENTUM_MAX_ENTRY_PRICE") ?? "0.45"),
    stopLossPct: parseFloat(Env.get("MOMENTUM_STOP_LOSS_PCT") ?? "0.35"),
    takeProfitPct: parseFloat(Env.get("MOMENTUM_TAKE_PROFIT_PCT") ?? "0.5"),
  };
}

type State = {
  entered: boolean;
  enteredSide: "UP" | "DOWN" | null;
  enteredAtPrice: number;
  shares: number;
};

type PriceWindow = { price: number; timestamp: number };

const DEFAULT_SHARES = 6;

export const momentumContinuation: Strategy = async (ctx) => {
  if (!Env.get("DRY_RUN_ENABLED")) {
    ctx.log("[momentum] DRY_RUN_REQUIRED", "red"); process.exit(1);
  }
  const cfg = loadConfig();
  if (!cfg.enabled) { ctx.log("[momentum] disabled", "dim"); return; }

  const release = ctx.hold();
  const state: State = { entered: false, enteredSide: null, enteredAtPrice: 0, shares: 0 };
  const windows: PriceWindow[] = [];
  let windowStart = Date.now();
  let windowStartPrice: number | null = null;

  const log = (msg: string, color: "cyan" | "green" | "yellow" | "red" | "dim" = "cyan") =>
    ctx.log(`[momentum] ${msg}`, color);

  const checkMomentum = (): { side: "UP" | "DOWN"; consecutive: number; changePct: number } | null => {
    if (windows.length < cfg.lookbackWindows + 1) return null;
    const recent = windows.slice(-(cfg.lookbackWindows + 1));
    let consecutive = 1;
    let direction: "UP" | "DOWN" | null = null;
    for (let i = 1; i < recent.length; i++) {
      const d = recent[i].price > recent[i - 1].price ? "UP" : "DOWN";
      if (d === direction) consecutive++;
      else { direction = d; consecutive = 1; }
    }
    if (consecutive < cfg.minConsecutiveDirection || !direction) return null;
    const firstPrice = recent[0].price;
    const lastPrice = recent[recent.length - 1].price;
    const changePct = ((lastPrice - firstPrice) / firstPrice) * 100;
    if (Math.abs(changePct) < cfg.minPriceChangePct) return null;
    return { side: direction, consecutive, changePct };
  };

  const interval = setInterval(() => {
    const remaining = Math.floor((ctx.slotEndMs - Date.now()) / 1000);
    if (remaining <= 0) { clearInterval(interval); release(); return; }

    // Record price window every ~1s
    const price = ctx.ticker.price;
    if (price === undefined) return;
    windows.push({ price, timestamp: Date.now() });
    if (windows.length > cfg.lookbackWindows * 3) windows.shift();

    // Check window change
    const now = Date.now();
    const windowDuration = (now - windowStart) / 1000;
    if (windowDuration >= 1) {
      // New 1-second window
      windowStart = now;
      windowStartPrice = price;
    }

    if (!state.entered) {
      const mom = checkMomentum();
      if (!mom) return;

      const upAsk = ctx.orderBook.bestAskInfo("UP");
      const downAsk = ctx.orderBook.bestAskInfo("DOWN");
      if (!upAsk || !downAsk) return;

      const entryPrice = mom.side === "UP" ? upAsk.price : downAsk.price;
      if (entryPrice > cfg.maxEntryPrice) { log(`entry price ${entryPrice.toFixed(3)} > max ${cfg.maxEntryPrice}`, "dim"); return; }

      const liq = mom.side === "UP" ? upAsk.liquidity : downAsk.liquidity;
      if (liq < cfg.minVolume) { log(`low volume ${liq}`, "dim"); return; }

      log(`momentum signal: ${mom.side} (${mom.consecutive}x, ${mom.changePct.toFixed(2)}%) @ ${entryPrice.toFixed(4)}`, "cyan");
      placeBuy(ctx, state, mom.side, entryPrice, log, () => { clearInterval(interval); release(); });
    } else {
      // Manage position
      const posSide = state.enteredSide!;
      const currentAsk = ctx.orderBook.bestAskInfo(posSide)?.price ?? 0;
      if (currentAsk === 0) return;
      const pnlPct = ((currentAsk - state.enteredAtPrice) / state.enteredAtPrice) * (posSide === "UP" ? 1 : -1);

      if (pnlPct >= cfg.takeProfitPct) {
        const bestBid = ctx.orderBook.bestBidPrice(posSide) ?? currentAsk - 0.01;
        log(`TP @ ${bestBid.toFixed(4)} (+${(pnlPct * 100).toFixed(1)}%)`, "green");
        placeSell(ctx, state, bestBid, log, () => { clearInterval(interval); release(); });
      } else if (pnlPct <= -cfg.stopLossPct) {
        const bestBid = ctx.orderBook.bestBidPrice(posSide) ?? currentAsk - 0.01;
        log(`SL @ ${bestBid.toFixed(4)} (${(pnlPct * 100).toFixed(1)}%)`, "red");
        placeSell(ctx, state, bestBid, log, () => { clearInterval(interval); release(); });
      } else if (remaining <= 5) {
        const bestBid = ctx.orderBook.bestBidPrice(posSide) ?? currentAsk;
        placeSell(ctx, state, bestBid, log, () => { clearInterval(interval); release(); });
      }
    }
  }, 200);

  return () => clearInterval(interval);
};

function placeBuy(
  ctx: StrategyContext,
  state: State,
  side: "UP" | "DOWN",
  price: number,
  log: (msg: string, color?: "cyan" | "green" | "yellow" | "red" | "dim") => void,
  onDone: () => void,
) {
  const tokenId = side === "UP" ? ctx.clobTokenIds[0] : ctx.clobTokenIds[1];
  const shares = DEFAULT_SHARES;
  state.entered = true; state.enteredSide = side; state.enteredAtPrice = price; state.shares = shares;
  ctx.postOrders([{
    req: { tokenId, action: "buy", price, shares },
    expireAtMs: ctx.slotEndMs,
    onFilled(filledShares) { log(`BUY ${side} @ ${price} filled (${filledShares})`, "green"); },
    onExpired() { log("entry expired", "yellow"); state.entered = false; onDone(); },
    onFailed(r) { log(`entry failed: ${r}`, "red"); state.entered = false; onDone(); },
  }]);
}

function placeSell(
  ctx: StrategyContext,
  state: State,
  price: number,
  log: (msg: string, color?: "cyan" | "green" | "yellow" | "red" | "dim") => void,
  onDone: () => void,
) {
  const posSide = state.enteredSide!;
  const tokenId = posSide === "UP" ? ctx.clobTokenIds[0] : ctx.clobTokenIds[1];
  ctx.postOrders([{
    req: { tokenId, action: "sell", price, shares: state.shares },
    expireAtMs: ctx.slotEndMs,
    onFilled() { log(`SELL ${posSide} @ ${price} filled`, "green"); state.entered = false; onDone(); },
    onExpired() { log("sell expired", "red"); ctx.emergencySells(ctx.pendingOrders.filter(o => o.action === "sell").map(o => o.orderId)); state.entered = false; onDone(); },
  }]);
}

export default momentumContinuation;