/**
 * 11. Synthetic Opposite-Side Entry
 *
 * Ao invés de comprar UP, vende DOWN.
 * Economicamente equivalente, mas às vezes tem liquidez melhor no lado oposto.
 */
import type { Strategy, StrategyContext } from "../types.ts";
import { Env } from "../../utils/config.ts";

type SyntheticConfig = {
  enabled: boolean;
  preferredSide: "UP" | "DOWN" | "auto";
  minLiqRatio: number;           // min liquidity ratio to consider opposite
  maxEntryPrice: number;
  stopLossPct: number;
  takeProfitPct: number;
};

function loadConfig(): SyntheticConfig {
  return {
    enabled: Env.get("ENABLE_SYNTHETIC_OPPOSITE") !== "false",
    preferredSide: (Env.get("SYNTHETIC_PREFERRED_SIDE") as "UP" | "DOWN" | "auto") ?? "auto",
    minLiqRatio: parseFloat(Env.get("SYNTHETIC_MIN_LIQ_RATIO") ?? "1.2"),
    maxEntryPrice: parseFloat(Env.get("SYNTHETIC_MAX_ENTRY_PRICE") ?? "0.45"),
    stopLossPct: parseFloat(Env.get("SYNTHETIC_STOP_LOSS_PCT") ?? "0.35"),
    takeProfitPct: parseFloat(Env.get("SYNTHETIC_TAKE_PROFIT_PCT") ?? "0.5"),
  };
}

type State = { entered: boolean; enteredSide: "UP" | "DOWN" | null; enteredAtPrice: number; shares: number; synthetic: boolean };

const DEFAULT_SHARES = 6;

export const syntheticOpposite: Strategy = async (ctx) => {
  if (!Env.get("DRY_RUN_ENABLED")) { ctx.log("[synthetic-opposite] DRY_RUN_REQUIRED", "red"); process.exit(1); }
  const cfg = loadConfig();
  if (!cfg.enabled) { ctx.log("[synthetic-opposite] disabled", "dim"); return; }

  const release = ctx.hold();
  const state: State = { entered: false, enteredSide: null, enteredAtPrice: 0, shares: 0, synthetic: false };

  const log = (msg: string, color: "cyan" | "green" | "yellow" | "red" | "dim" = "cyan") =>
    ctx.log(`[synthetic-opposite] ${msg}`, color);

  const interval = setInterval(() => {
    const remaining = Math.floor((ctx.slotEndMs - Date.now()) / 1000);
    if (remaining <= 0) { clearInterval(interval); release(); return; }

    if (!state.entered) {
      const upAsk = ctx.orderBook.bestAskInfo("UP");
      const downAsk = ctx.orderBook.bestAskInfo("DOWN");
      const upBid = ctx.orderBook.bestBidInfo("UP");
      const downBid = ctx.orderBook.bestBidInfo("DOWN");
      if (!upAsk || !downAsk || !upBid || !downBid) return;

      const upLiq = upAsk.liquidity, downLiq = downAsk.liquidity;
      const upPrice = upAsk.price, downPrice = downAsk.price;

      // Determine desired direction
      let targetSide: "UP" | "DOWN";
      if (cfg.preferredSide === "auto") {
        // Default: follow the cheaper side (more upside)
        targetSide = upPrice <= downPrice ? "UP" : "DOWN";
      } else {
        targetSide = cfg.preferredSide;
      }

      const naturalTokenId = targetSide === "UP" ? ctx.clobTokenIds[0] : ctx.clobTokenIds[1];
      const naturalPrice = targetSide === "UP" ? upPrice : downPrice;
      const naturalLiq = targetSide === "UP" ? upLiq : downLiq;

      const oppositeTokenId = targetSide === "UP" ? ctx.clobTokenIds[1] : ctx.clobTokenIds[0];
      const oppositePrice = targetSide === "UP" ? downPrice : upPrice;
      const oppositeLiq = targetSide === "UP" ? downLiq : upLiq;

      // Check liquidity ratio — use synthetic if opposite has enough more liquidity
      const liqRatio = oppositeLiq / (naturalLiq + 0.001);
      let useSynthetic = liqRatio >= cfg.minLiqRatio && oppositeLiq > naturalLiq;
      let entryPrice: number, entryTokenId: string, synthetic: boolean;

      if (useSynthetic) {
        entryPrice = oppositePrice;
        entryTokenId = oppositeTokenId;
        synthetic = true;
        log(`synthetic: selling ${targetSide === "UP" ? "DOWN" : "UP"} @ ${entryPrice.toFixed(4)} (liq ratio=${liqRatio.toFixed(2)})`, "cyan");
      } else {
        entryPrice = naturalPrice;
        entryTokenId = naturalTokenId;
        synthetic = false;
        if (entryPrice > cfg.maxEntryPrice) { log(`price too high ${entryPrice.toFixed(3)}`, "dim"); return; }
        log(`natural: ${targetSide} @ ${entryPrice.toFixed(4)} (liq ratio=${liqRatio.toFixed(2)})`, "cyan");
      }

      if (entryPrice > cfg.maxEntryPrice) { log(`price > max ${cfg.maxEntryPrice}`, "dim"); return; }

      state.entered = true; state.enteredSide = targetSide; state.enteredAtPrice = entryPrice; state.shares = DEFAULT_SHARES; state.synthetic = synthetic;

      ctx.postOrders([{
        req: { tokenId: entryTokenId, action: "buy", price: entryPrice, shares: DEFAULT_SHARES },
        expireAtMs: ctx.slotEndMs,
        onFilled(filledShares) { log(`BUY (synthetic=${synthetic}) filled @ ${entryPrice} (${filledShares})`, "green"); },
        onExpired() { log("entry expired", "yellow"); state.entered = false; clearInterval(interval); release(); },
        onFailed(r) { log(`entry failed: ${r}`, "red"); state.entered = false; clearInterval(interval); release(); },
      }]);
    } else {
      // Exit management
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

function placeSell(ctx: StrategyContext, state: State, price: number,
  log: (msg: string, color?: "cyan" | "green" | "yellow" | "red" | "dim") => void, onDone: () => void) {
  const posSide = state.enteredSide!;
  const tokenId = posSide === "UP" ? ctx.clobTokenIds[0] : ctx.clobTokenIds[1];
  ctx.postOrders([{ req: { tokenId, action: "sell", price, shares: state.shares }, expireAtMs: ctx.slotEndMs,
    onFilled() { log(`SELL @ ${price} (synthetic=${state.synthetic})`, "green"); state.entered = false; onDone(); },
    onExpired() { log("sell expired", "red"); ctx.emergencySells(ctx.pendingOrders.filter(o => o.action === "sell").map(o => o.orderId)); state.entered = false; onDone(); },
  }]);
}

export default syntheticOpposite;