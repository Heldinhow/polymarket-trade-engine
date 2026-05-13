/**
 * 6. Spot Distance From Strike
 *
 * Compara preço real spot (Binance) vs strike implícito do mercado.
 * Útil em mercados rápidos — spot pode领先 ou lag o mercado.
 *
 * Example:
 *   Mercado ainda acha DOWN provável
 *   Mas spot já está muito acima do strike
 *   => compra UP
 */
import type { Strategy, StrategyContext } from "../types.ts";
import { Env } from "../../../utils/config.ts";

type SpotDistanceConfig = {
  enabled: boolean;
  minSpotDistancePct: number;     // min % gap between spot and strike
  maxEntryPrice: number;
  spotRefreshMs: number;
  stopLossPct: number;
  takeProfitPct: number;
};

function loadConfig(): SpotDistanceConfig {
  return {
    enabled: Env.get("ENABLE_SPOT_DISTANCE_STRATEGY") !== "false",
    minSpotDistancePct: parseFloat(Env.get("SPOT_DISTANCE_MIN_PCT") ?? "0.5"),
    maxEntryPrice: parseFloat(Env.get("SPOT_DISTANCE_MAX_ENTRY_PRICE") ?? "0.45"),
    spotRefreshMs: parseInt(Env.get("SPOT_DISTANCE_REFRESH_MS") ?? "2000", 10),
    stopLossPct: parseFloat(Env.get("SPOT_DISTANCE_STOP_LOSS_PCT") ?? "0.35"),
    takeProfitPct: parseFloat(Env.get("SPOT_DISTANCE_TAKE_PROFIT_PCT") ?? "0.5"),
  };
}

type State = { entered: boolean; enteredSide: "UP" | "DOWN" | null; enteredAtPrice: number; shares: number };

const DEFAULT_SHARES = 6;

export const spotDistance: Strategy = async (ctx) => {
  if (!Env.get("DRY_RUN_ENABLED")) { ctx.log("[spot-distance] DRY_RUN_REQUIRED", "red"); process.exit(1); }
  const cfg = loadConfig();
  if (!cfg.enabled) { ctx.log("[spot-distance] disabled", "dim"); return; }

  const release = ctx.hold();
  const state: State = { entered: false, enteredSide: null, enteredAtPrice: 0, shares: 0 };

  const log = (msg: string, color: "cyan" | "green" | "yellow" | "red" | "dim" = "cyan") =>
    ctx.log(`[spot-distance] ${msg}`, color);

  let cachedSpotPrice: number | null = null;
  let lastSpotFetch = 0;

  const fetchSpot = async () => {
    const now = Date.now();
    if (now - lastSpotFetch < cfg.spotRefreshMs) return;
    lastSpotFetch = now;
    try {
      const asset = ctx.slug.includes("eth") ? "ETHUSDT" : ctx.slug.includes("sol") ? "SOLUSDT" : "BTCUSDT";
      const resp = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${asset}`);
      const data = await resp.json() as { price: string };
      cachedSpotPrice = parseFloat(data.price);
    } catch { /* keep previous */ }
  };

  const interval = setInterval(async () => {
    const remaining = Math.floor((ctx.slotEndMs - Date.now()) / 1000);
    if (remaining <= 0) { clearInterval(interval); release(); return; }

    await fetchSpot();
    if (cachedSpotPrice === null) return;

    const strike = ctx.getMarketResult()?.openPrice;
    if (strike === undefined || strike === null) return;

    const distancePct = ((cachedSpotPrice - strike) / strike) * 100;
    const upAsk = ctx.orderBook.bestAskInfo("UP");
    const downAsk = ctx.orderBook.bestAskInfo("DOWN");
    if (!upAsk || !downAsk) return;

    if (!state.entered) {
      // Spot far above strike → market odds underestimate UP probability → buy UP
      if (distancePct >= cfg.minSpotDistancePct) {
        const entryPrice = upAsk.price;
        if (entryPrice > cfg.maxEntryPrice) { log(`price ${entryPrice.toFixed(3)} > max`, "dim"); return; }
        log(`spot=${cachedSpotPrice} strike=${strike} (+${distancePct.toFixed(2)}%) → UP @ ${entryPrice.toFixed(4)}`, "cyan");
        placeBuy(ctx, state, "UP", entryPrice, log, () => { clearInterval(interval); release(); });
      }
      // Spot far below strike → market odds underestimate DOWN probability → buy DOWN
      else if (distancePct <= -cfg.minSpotDistancePct) {
        const entryPrice = downAsk.price;
        if (entryPrice > cfg.maxEntryPrice) { log(`price ${entryPrice.toFixed(3)} > max`, "dim"); return; }
        log(`spot=${cachedSpotPrice} strike=${strike} (${distancePct.toFixed(2)}%) → DOWN @ ${entryPrice.toFixed(4)}`, "cyan");
        placeBuy(ctx, state, "DOWN", entryPrice, log, () => { clearInterval(interval); release(); });
      }
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
  }, 500);

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

export default spotDistance;