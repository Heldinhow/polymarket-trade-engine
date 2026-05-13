/**
 * 8. Day / Hour Edge
 *
 * Explora padrões estatísticos de horário.
 * Exploits:
 *   - segunda-feira 10h
 *   - fechamento NY
 *   - abertura asiática
 *   - horários de notícia
 */
import type { Strategy, StrategyContext } from "../types.ts";
import { Env } from "../../../utils/config.ts";

type DayHourEdgeConfig = {
  enabled: boolean;
  entryHourStart: number;          // 0-23
  entryHourEnd: number;            // 0-23 (inclusive)
  entryDays: number[];             // 0=Sun, 1=Mon, ..., 6=Sat
  sideBias: "UP" | "DOWN" | "mixed";
  momentumLookback: number;        // lookback windows for direction
  maxEntryPrice: number;
  minMomentumScore: number;
  stopLossPct: number;
  takeProfitPct: number;
};

function loadConfig(): DayHourEdgeConfig {
  return {
    enabled: Env.get("ENABLE_DAY_HOUR_EDGE") !== "false",
    entryHourStart: parseInt(Env.get("DAY_HOUR_EDGE_START_HOUR") ?? "0", 10),
    entryHourEnd: parseInt(Env.get("DAY_HOUR_EDGE_END_HOUR") ?? "23", 10),
    entryDays: (Env.get("DAY_HOUR_EDGE_DAYS") ?? "0,1,2,3,4,5,6").split(",").map(Number),
    sideBias: (Env.get("DAY_HOUR_EDGE_SIDE_BIAS") as "UP" | "DOWN" | "mixed") ?? "mixed",
    momentumLookback: parseInt(Env.get("DAY_HOUR_EDGE_MOMENTUM_LOOKBACK") ?? "5", 10),
    maxEntryPrice: parseFloat(Env.get("DAY_HOUR_EDGE_MAX_ENTRY_PRICE") ?? "0.45"),
    minMomentumScore: parseFloat(Env.get("DAY_HOUR_EDGE_MIN_MOMENTUM_SCORE") ?? "0.1"),
    stopLossPct: parseFloat(Env.get("DAY_HOUR_EDGE_STOP_LOSS_PCT") ?? "0.35"),
    takeProfitPct: parseFloat(Env.get("DAY_HOUR_EDGE_TAKE_PROFIT_PCT") ?? "0.5"),
  };
}

type State = { entered: boolean; enteredSide: "UP" | "DOWN" | null; enteredAtPrice: number; shares: number };
type PriceSample = { price: number; ts: number };

const DEFAULT_SHARES = 6;

export const dayHourEdge: Strategy = async (ctx) => {
  if (!Env.get("DRY_RUN_ENABLED")) { ctx.log("[day-hour-edge] DRY_RUN_REQUIRED", "red"); process.exit(1); }
  const cfg = loadConfig();
  if (!cfg.enabled) { ctx.log("[day-hour-edge] disabled", "dim"); return; }

  const release = ctx.hold();
  const state: State = { entered: false, enteredSide: null, enteredAtPrice: 0, shares: 0 };
  const priceSamples: PriceSample[] = [];

  const log = (msg: string, color: "cyan" | "green" | "yellow" | "red" | "dim" = "cyan") =>
    ctx.log(`[day-hour-edge] ${msg}`, color);

  const isActiveHour = (): boolean => {
    const now = new Date();
    const hour = now.getUTCHours();
    const day = now.getUTCDay();
    const inHourRange = hour >= cfg.entryHourStart && hour <= cfg.entryHourEnd;
    const inDay = cfg.entryDays.includes(day);
    return inHourRange && inDay;
  };

  const detectMomentum = (): "UP" | "DOWN" | null => {
    if (priceSamples.length < cfg.momentumLookback + 1) return null;
    const recent = priceSamples.slice(-(cfg.momentumLookback + 1));
    let ups = 0, downs = 0;
    for (let i = 1; i < recent.length; i++) {
      if (recent[i].price > recent[i - 1].price) ups++;
      else if (recent[i].price < recent[i - 1].price) downs++;
    }
    const total = ups + downs;
    if (total < 3) return null;
    const score = Math.abs(ups - downs) / total;
    if (score < cfg.minMomentumScore) return null;
    return ups > downs ? "UP" : "DOWN";
  };

  const interval = setInterval(() => {
    const remaining = Math.floor((ctx.slotEndMs - Date.now()) / 1000);
    if (remaining <= 0) { clearInterval(interval); release(); return; }

    const price = ctx.ticker.price;
    if (price !== undefined) {
      priceSamples.push({ price, ts: Date.now() });
      if (priceSamples.length > 300) priceSamples.shift();
    }

    if (!state.entered && isActiveHour()) {
      const momentum = detectMomentum();
      if (!momentum) return;

      let side: "UP" | "DOWN";
      if (cfg.sideBias === "mixed") side = momentum;
      else side = cfg.sideBias === "UP" || (cfg.sideBias === "DOWN" && momentum === "DOWN") ? "UP" : momentum === "DOWN" ? "DOWN" : "UP";

      const upAsk = ctx.orderBook.bestAskInfo("UP");
      const downAsk = ctx.orderBook.bestAskInfo("DOWN");
      if (!upAsk || !downAsk) return;

      const entryPrice = side === "UP" ? upAsk.price : downAsk.price;
      if (entryPrice > cfg.maxEntryPrice) { log(`price too high ${entryPrice.toFixed(3)}`, "dim"); return; }

      const hour = new Date().getUTCHours();
      log(`edge window: ${hour}h UTC momentum=${momentum} → ${side} @ ${entryPrice.toFixed(4)}`, "cyan");
      placeBuy(ctx, state, side, entryPrice, log, () => { clearInterval(interval); release(); });
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

export default dayHourEdge;