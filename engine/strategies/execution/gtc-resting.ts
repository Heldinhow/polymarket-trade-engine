/**
 * 10. GTC Resting Limit
 *
 * Deixa ordem descansando no book.
 * Coloca no mid + 1 tick como limit order.
 * Objetivo: virar maker e conseguir fill melhor.
 */
import type { Strategy, StrategyContext } from "../types.ts";
import { Env } from "../../../utils/config.ts";

type GtcRestingConfig = {
  enabled: boolean;
  restingOffsetTicks: number;    // ticks above mid (e.g. 1 tick = 0.01)
  maxWaitSeconds: number;        // give up if not filled
  minLiquidity: number;
  maxEntryPrice: number;
  postOnly: boolean;             // if true, ensure maker-only
};

function loadConfig(): GtcRestingConfig {
  return {
    enabled: Env.get("ENABLE_GTC_RESTING") !== "false",
    restingOffsetTicks: parseFloat(Env.get("GTC_RESTING_TICKS") ?? "1"),
    maxWaitSeconds: parseInt(Env.get("GTC_RESTING_MAX_WAIT") ?? "60", 10),
    minLiquidity: parseFloat(Env.get("GTC_RESTING_MIN_LIQUIDITY") ?? "50"),
    maxEntryPrice: parseFloat(Env.get("GTC_RESTING_MAX_ENTRY_PRICE") ?? "0.45"),
    postOnly: Env.get("GTC_RESTING_POST_ONLY") === "true",
  };
}

const TICK_SIZE = 0.01;
const DEFAULT_SHARES = 6;

export const gtcResting: Strategy = async (ctx) => {
  if (!Env.get("DRY_RUN_ENABLED")) { ctx.log("[gtc-resting] DRY_RUN_REQUIRED", "red"); process.exit(1); }
  const cfg = loadConfig();
  if (!cfg.enabled) { ctx.log("[gtc-resting] disabled", "dim"); return; }

  const release = ctx.hold();
  const state = { entered: false, enteredSide: null as "UP" | "DOWN" | null, enteredAtPrice: 0, shares: 0 };
  const placedOrderIds: string[] = [];
  let placedAt = 0;

  const log = (msg: string, color: "cyan" | "green" | "yellow" | "red" | "dim" = "cyan") =>
    ctx.log(`[gtc-resting] ${msg}`, color);

  let pendingOrderId: string | null = null;

  const interval = setInterval(() => {
    const remaining = Math.floor((ctx.slotEndMs - Date.now()) / 1000);
    if (remaining <= 0) { clearInterval(interval); release(); return; }

    if (state.entered) { clearInterval(interval); release(); return; }

    // Wait too long without fill → cancel and give up
    if (placedAt > 0 && (Date.now() - placedAt) / 1000 > cfg.maxWaitSeconds) {
      log("max wait exceeded — cancelling resting order", "yellow");
      if (pendingOrderId) {
        ctx.cancelOrders([pendingOrderId]).then(() => { release(); });
      } else { release(); }
      clearInterval(interval); return;
    }

    const upAsk = ctx.orderBook.bestAskInfo("UP");
    const downAsk = ctx.orderBook.bestAskInfo("DOWN");
    if (!upAsk || !downAsk) return;
    if (upAsk.liquidity < cfg.minLiquidity && downAsk.liquidity < cfg.minLiquidity) { log("low liquidity", "dim"); return; }

    const midPrice = (upAsk.price + downAsk.price) / 2;

    if (!pendingOrderId) {
      // Choose side: whichever is below maxEntryPrice
      const candidates: Array<{ side: "UP" | "DOWN"; price: number; liq: number }> = [];
      const upPrice = upAsk.price;
      const downPrice = downAsk.price;
      if (upPrice <= cfg.maxEntryPrice) candidates.push({ side: "UP", price: upPrice, liq: upAsk.liquidity });
      if (downPrice <= cfg.maxEntryPrice) candidates.push({ side: "DOWN", price: downPrice, liq: downAsk.liquidity });
      if (candidates.length === 0) { log("both sides above maxEntryPrice", "dim"); return; }

      // Pick side with best liquidity
      candidates.sort((a, b) => b.liq - a.liq);
      const chosen = candidates[0];

      // Resting price: mid + offset ticks (try to improve over mid)
      const restingPrice = Math.min(chosen.price, midPrice + cfg.restingOffsetTicks * TICK_SIZE);

      const tokenId = chosen.side === "UP" ? ctx.clobTokenIds[0] : ctx.clobTokenIds[1];
      placedAt = Date.now();

      log(`resting ${chosen.side} @ ${restingPrice.toFixed(4)} (mid=${midPrice.toFixed(4)}, liq=${chosen.liq.toFixed(0)})`, "cyan");

      ctx.postOrders([{
        req: { tokenId, action: "buy", price: restingPrice, shares: DEFAULT_SHARES, orderType: "GTC" },
        expireAtMs: ctx.slotEndMs,
        onFilled(filledShares) {
          log(`GTC ${chosen.side} filled @ ${restingPrice} (${filledShares} shares)`, "green");
          state.entered = true; state.enteredSide = chosen.side; state.enteredAtPrice = restingPrice; state.shares = filledShares;
          pendingOrderId = null; clearInterval(interval); release();
        },
        onExpired() { log("resting order expired", "yellow"); pendingOrderId = null; placedAt = 0; },
        onFailed(reason) { log(`resting failed: ${reason}`, "red"); pendingOrderId = null; placedAt = 0; },
      }]);
    }
  }, 300);

  return () => clearInterval(interval);
};

export default gtcResting;