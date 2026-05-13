/**
 * 5. CLOB Momentum
 *
 * Baseado no order book — não usa indicadores técnicos.
 * Olha agressão no CLOB, imbalance, velocidade das ordens, pressão compradora/vendedora.
 *
 * Example:
 *   bids sendo consumidos rápido
 *   asks desaparecendo
 *   => entra UP
 */
import type { Strategy, StrategyContext } from "../types.ts";
import { Env } from "../../utils/config.ts";

type ClobMomentumConfig = {
  enabled: boolean;
  imbalanceThreshold: number;       // e.g. 0.3 (30% imbalance)
  velocityWindowMs: number;         // window to measure order book velocity
  minDepthGap: number;              // min depth difference between bids/asks
  maxEntryPrice: number;
  stopLossPct: number;
  takeProfitPct: number;
};

function loadConfig(): ClobMomentumConfig {
  return {
    enabled: Env.get("ENABLE_CLOB_MOMENTUM") !== "false",
    imbalanceThreshold: parseFloat(Env.get("CLOB_IMBALANCE_THRESHOLD") ?? "0.3"),
    velocityWindowMs: parseInt(Env.get("CLOB_VELOCITY_WINDOW_MS") ?? "5000", 10),
    minDepthGap: parseFloat(Env.get("CLOB_MIN_DEPTH_GAP") ?? "50"),
    maxEntryPrice: parseFloat(Env.get("CLOB_MAX_ENTRY_PRICE") ?? "0.45"),
    stopLossPct: parseFloat(Env.get("CLOB_STOP_LOSS_PCT") ?? "0.35"),
    takeProfitPct: parseFloat(Env.get("CLOB_TAKE_PROFIT_PCT") ?? "0.5"),
  };
}

type DepthSample = { bidDepth: number; askDepth: number; ts: number };
type State = { entered: boolean; enteredSide: "UP" | "DOWN" | null; enteredAtPrice: number; shares: number };

const DEFAULT_SHARES = 6;

export const clobMomentum: Strategy = async (ctx) => {
  if (!Env.get("DRY_RUN_ENABLED")) { ctx.log("[clob-momentum] DRY_RUN_REQUIRED", "red"); process.exit(1); }
  const cfg = loadConfig();
  if (!cfg.enabled) { ctx.log("[clob-momentum] disabled", "dim"); return; }

  const release = ctx.hold();
  const state: State = { entered: false, enteredSide: null, enteredAtPrice: 0, shares: 0 };
  const depthHistory: DepthSample[] = [];

  const log = (msg: string, color: "cyan" | "green" | "yellow" | "red" | "dim" = "cyan") =>
    ctx.log(`[clob-momentum] ${msg}`, color);

  const interval = setInterval(() => {
    const remaining = Math.floor((ctx.slotEndMs - Date.now()) / 1000);
    if (remaining <= 0) { clearInterval(interval); release(); return; }

    const upAsk = ctx.orderBook.bestAskInfo("UP");
    const downAsk = ctx.orderBook.bestAskInfo("DOWN");
    const upBid = ctx.orderBook.bestBidInfo("UP");
    const downBid = ctx.orderBook.bestBidInfo("DOWN");
    if (!upAsk || !downAsk || !upBid || !downBid) return;

    const bidDepth = upBid.liquidity + downBid.liquidity;
    const askDepth = upAsk.liquidity + downAsk.liquidity;
    const now = Date.now();

    depthHistory.push({ bidDepth, askDepth, ts: now });
    const cutoff = now - cfg.velocityWindowMs;
    while (depthHistory.length > 0 && depthHistory[0].ts < cutoff) depthHistory.shift();

    if (!state.entered && depthHistory.length >= 3) {
      // Compute imbalance
      const imbalance = (bidDepth - askDepth) / (bidDepth + askDepth + 0.001);
      const prevSample = depthHistory[depthHistory.length - 2];
      const depthDelta = (bidDepth - askDepth) - (prevSample!.bidDepth - prevSample!.askDepth);

      // Strong buy pressure: bidDepth >> askDepth AND growing
      if (imbalance > cfg.imbalanceThreshold && depthDelta > cfg.minDepthGap) {
        const entryPrice = upAsk.price;
        if (entryPrice > cfg.maxEntryPrice) { log(`price ${entryPrice.toFixed(3)} > max`, "dim"); return; }
        log(`BUY pressure: imbalance=${imbalance.toFixed(2)} Δdepth=${depthDelta.toFixed(0)} → UP @ ${entryPrice.toFixed(4)}`, "cyan");
        placeBuy(ctx, state, "UP", entryPrice, log, () => { clearInterval(interval); release(); });
      } else if (imbalance < -cfg.imbalanceThreshold && depthDelta < -cfg.minDepthGap) {
        const entryPrice = downAsk.price;
        if (entryPrice > cfg.maxEntryPrice) { log(`price ${entryPrice.toFixed(3)} > max`, "dim"); return; }
        log(`SELL pressure: imbalance=${imbalance.toFixed(2)} Δdepth=${depthDelta.toFixed(0)} → DOWN @ ${entryPrice.toFixed(4)}`, "cyan");
        placeBuy(ctx, state, "DOWN", entryPrice, log, () => { clearInterval(interval); release(); });
      }
    } else if (state.entered) {
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
  }, 300);

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

export default clobMomentum;