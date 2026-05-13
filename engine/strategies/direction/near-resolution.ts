/**
 * 2. Near Resolution / 99c Strategy
 *
 * Explota mercados perto de resolution.
 * Quando UP ou DOWN chega a 97c/98c/99c, tenta capturar o edge de 1-3%.
 *
 * Variants:
 *   following — segue o lado dominante
 *   contrarian  — aposta contra spike exagerado
 */
import type { Strategy, StrategyContext } from "../types.ts";
import { Env } from "../../../utils/config.ts";

type NearResolutionConfig = {
  nearResolutionPrice: number;   // e.g. 0.97
  maxSecondsToClose: number;     // e.g. 30
  maxSpread: number;             // e.g. 0.05
  minLiquidity: number;           // e.g. 100
  variant: "following" | "contrarian";
  maxRecentOddsJump: number;      // contrarian: max jump from mid to warrant reversion
  stopLossPct: number;
  takeProfitPrice: number;
  enabled: boolean;
};

function loadConfig(): NearResolutionConfig {
  return {
    nearResolutionPrice: parseFloat(Env.get("NEAR_RESOLUTION_PRICE") ?? "0.97"),
    maxSecondsToClose: parseInt(Env.get("NEAR_RESOLUTION_MAX_SECONDS_TO_CLOSE") ?? "30", 10),
    maxSpread: parseFloat(Env.get("NEAR_RESOLUTION_MAX_SPREAD") ?? "0.05"),
    minLiquidity: parseFloat(Env.get("NEAR_RESOLUTION_MIN_LIQUIDITY") ?? "100"),
    variant: (Env.get("NEAR_RESOLUTION_VARIANT") as "following" | "contrarian") ?? "following",
    maxRecentOddsJump: parseFloat(Env.get("NEAR_RESOLUTION_MAX_RECENT_ODDS_JUMP") ?? "0.1"),
    stopLossPct: parseFloat(Env.get("NEAR_RESOLUTION_STOP_LOSS_PCT") ?? "0.08"),
    takeProfitPrice: parseFloat(Env.get("NEAR_RESOLUTION_TAKE_PROFIT_PRICE") ?? "0.99"),
    enabled: Env.get("ENABLE_NEAR_RESOLUTION_STRATEGY") !== "false",
  };
}

type State = {
  entered: boolean;
  enteredSide: "UP" | "DOWN" | null;
  enteredAtPrice: number;
  shares: number;
  stopFired: boolean;
};

const DEFAULT_SHARES = 8;

export const nearResolution: Strategy = async (ctx) => {
  if (!Env.get("DRY_RUN_ENABLED")) {
    ctx.log("[near-resolution] DRY_RUN_REQUIRED — aborting", "red");
    process.exit(1);
  }

  const cfg = loadConfig();
  if (!cfg.enabled) { ctx.log("[near-resolution] disabled", "dim"); return; }

  const release = ctx.hold();
  const state: State = { entered: false, enteredSide: null, enteredAtPrice: 0, shares: 0, stopFired: false };

  const log = (msg: string, color: "cyan" | "green" | "yellow" | "red" | "dim" = "cyan") =>
    ctx.log(`[near-resolution] ${msg}`, color);

  let prevMidPrice = 0;
  let priceVelocity = 0;

  const interval = setInterval(() => {
    const remaining = Math.floor((ctx.slotEndMs - Date.now()) / 1000);
    if (remaining <= 0) { clearInterval(interval); release(); return; }

    const upAsk = ctx.orderBook.bestAskInfo("UP");
    const downAsk = ctx.orderBook.bestAskInfo("DOWN");
    const upBid = ctx.orderBook.bestBidInfo("UP");
    const downBid = ctx.orderBook.bestBidInfo("DOWN");
    if (!upAsk || !downAsk || !upBid || !downBid) return;

    const upPrice = upAsk.price, downPrice = downAsk.price;
    const spread = upPrice - downPrice;
    if (spread > cfg.maxSpread) { log(`spread too wide ${spread.toFixed(3)}`, "dim"); return; }
    if (upAsk.liquidity < cfg.minLiquidity || downAsk.liquidity < cfg.minLiquidity) { log("low liquidity", "dim"); return; }
    if (remaining > cfg.maxSecondsToClose) { log(`too early: ${remaining}s`, "dim"); return; }

    const midPrice = (upPrice + downPrice) / 2;
    priceVelocity = midPrice - prevMidPrice;
    prevMidPrice = midPrice;

    // Which side is near resolution?
    const nearSide: "UP" | "DOWN" | null =
      upPrice >= cfg.nearResolutionPrice ? "UP" :
      downPrice >= cfg.nearResolutionPrice ? "DOWN" : null;

    if (state.entered) {
      // ── Manage open position ──────────────────────────────────────────────
      const posSide = state.enteredSide!;
      const currentAsk = ctx.orderBook.bestAskInfo(posSide)?.price ?? 0;
      const currentBid = ctx.orderBook.bestBidPrice(posSide);

      // Take profit
      if (currentAsk >= cfg.takeProfitPrice) {
        log(`TP hit @ ${currentAsk.toFixed(4)} — selling ${posSide}`, "green");
        placeSell(ctx, state, currentBid ?? currentAsk - 0.01, log);
        clearInterval(interval); release(); return;
      }

      // Stop loss
      const entryCost = state.enteredAtPrice * state.shares;
      const pnlPct = ((currentAsk - state.enteredAtPrice) / state.enteredAtPrice) * (posSide === "UP" ? 1 : -1);
      if (pnlPct <= -cfg.stopLossPct) {
        log(`SL hit @ ${currentAsk.toFixed(4)} — selling ${posSide}`, "red");
        placeSell(ctx, state, currentBid ?? currentAsk - 0.01, log);
        clearInterval(interval); release(); return;
      }

      // Time out
      if (remaining <= 5) {
        log(`timeout — selling ${posSide} @ ${currentBid ?? currentAsk}`, "yellow");
        placeSell(ctx, state, currentBid ?? currentAsk, log);
        clearInterval(interval); release(); return;
      }
    } else if (nearSide) {
      // ── Entry logic ───────────────────────────────────────────────────────
      if (cfg.variant === "contrarian") {
        // Contrarian: if price rocketed to near-resolution too fast, bet against
        if (Math.abs(priceVelocity) < cfg.maxRecentOddsJump) {
          log(`contrarian: velocity ${priceVelocity.toFixed(4)} below threshold — skipping`, "dim");
          return;
        }
        const entrySide: "UP" | "DOWN" = nearSide === "UP" ? "DOWN" : "UP";
        const entryPrice = entrySide === "UP" ? upAsk.price : downAsk.price;
        const entryLiq = entrySide === "UP" ? upAsk.liquidity : downAsk.liquidity;
        if (entryLiq < cfg.minLiquidity) return;
        log(`contrarian: ${entrySide} @ ${entryPrice.toFixed(4)} (velocity=${priceVelocity.toFixed(4)})`, "cyan");
        placeBuy(ctx, state, entrySide, entryPrice, log);
      } else {
        // Following: ride the dominant side
        const entryPrice = nearSide === "UP" ? upAsk.price : downAsk.price;
        const entryLiq = nearSide === "UP" ? upAsk.liquidity : downAsk.liquidity;
        if (entryLiq < cfg.minLiquidity) return;
        log(`following: ${nearSide} @ ${entryPrice.toFixed(4)} (remaining=${remaining}s)`, "cyan");
        placeBuy(ctx, state, nearSide, entryPrice, log);
      }
    }
  }, 500);

  return () => clearInterval(interval);
};

function placeBuy(
  ctx: StrategyContext,
  state: State,
  side: "UP" | "DOWN",
  price: number,
  log: (msg: string, color?: "cyan" | "green" | "yellow" | "red" | "dim") => void,
) {
  const tokenId = side === "UP" ? ctx.clobTokenIds[0] : ctx.clobTokenIds[1];
  const shares = DEFAULT_SHARES;
  state.entered = true; state.enteredSide = side; state.enteredAtPrice = price; state.shares = shares;

  ctx.postOrders([{
    req: { tokenId, action: "buy", price, shares },
    expireAtMs: ctx.slotEndMs,
    onFilled(filledShares) {
      log(`BUY ${side} filled @ ${price} (${filledShares} shares)`, "green");
    },
    onExpired() { log("entry expired", "yellow"); state.entered = false; releaseSafe(ctx); },
    onFailed(reason) { log(`entry failed: ${reason}`, "red"); state.entered = false; releaseSafe(ctx); },
  }]);
}

function placeSell(
  ctx: StrategyContext,
  state: State,
  price: number,
  log: (msg: string, color?: "cyan" | "green" | "yellow" | "red" | "dim") => void,
) {
  const posSide = state.enteredSide!;
  const tokenId = posSide === "UP" ? ctx.clobTokenIds[0] : ctx.clobTokenIds[1];
  ctx.postOrders([{
    req: { tokenId, action: "sell", price, shares: state.shares },
    expireAtMs: ctx.slotEndMs,
    onFilled() { log(`SELL ${posSide} filled @ ${price}`, "green"); state.entered = false; releaseSafe(ctx); },
    onExpired() { log("sell expired — emergency", "red"); ctx.emergencySells(ctx.pendingOrders.filter(o => o.action === "sell").map(o => o.orderId)); state.entered = false; releaseSafe(ctx); },
  }]);
}

function releaseSafe(ctx: StrategyContext & { _release?: () => void }) {
  if (ctx._release) { ctx._release(); ctx._release = undefined; }
}

export default nearResolution;