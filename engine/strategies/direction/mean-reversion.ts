/**
 * 4. Mean Reversion / Fake Spike
 *
 * Aposta contra exageros de movimento.
 * Quando odds distorcem rapidamente, espera pullback.
 *
 * Example:
 *   UP: 40c → 80c muito rápido
 *   => compra DOWN esperando reversão
 */
import type { Strategy, StrategyContext } from "../types.ts";
import { Env } from "../../../utils/config.ts";

type MeanReversionConfig = {
  enabled: boolean;
  spikeWindowSeconds: number;         // window to detect spike
  minOddsJump: number;                // min mid-price jump to qualify as spike
  minPriceMovePct: number;            // spot move % to confirm spike
  reversalConfirmationRequired: boolean;
  stopLossPct: number;
  takeProfitPct: number;
};

function loadConfig(): MeanReversionConfig {
  return {
    enabled: Env.get("ENABLE_MEAN_REVERSION_STRATEGY") !== "false",
    spikeWindowSeconds: parseInt(Env.get("MEAN_REVERSION_SPIKE_WINDOW_SECONDS") ?? "30", 10),
    minOddsJump: parseFloat(Env.get("MEAN_REVERSION_MIN_ODDS_JUMP") ?? "0.15"),
    minPriceMovePct: parseFloat(Env.get("MEAN_REVERSION_MIN_PRICE_MOVE_PCT") ?? "0.5"),
    reversalConfirmationRequired: Env.get("MEAN_REVERSION_REVERSAL_CONFIRMATION_REQUIRED") !== "false",
    stopLossPct: parseFloat(Env.get("MEAN_REVERSION_STOP_LOSS_PCT") ?? "0.35"),
    takeProfitPct: parseFloat(Env.get("MEAN_REVERSION_TAKE_PROFIT_PCT") ?? "0.5"),
  };
}

type State = {
  entered: boolean;
  enteredSide: "UP" | "DOWN" | null;
  enteredAtPrice: number;
  shares: number;
};

type MidHistory = { mid: number; ts: number };

const DEFAULT_SHARES = 6;

export const meanReversion: Strategy = async (ctx) => {
  if (!Env.get("DRY_RUN_ENABLED")) { ctx.log("[mean-reversion] DRY_RUN_REQUIRED", "red"); process.exit(1); }
  const cfg = loadConfig();
  if (!cfg.enabled) { ctx.log("[mean-reversion] disabled", "dim"); return; }

  const release = ctx.hold();
  const state: State = { entered: false, enteredSide: null, enteredAtPrice: 0, shares: 0 };
  const midHistory: MidHistory[] = [];

  const log = (msg: string, color: "cyan" | "green" | "yellow" | "red" | "dim" = "cyan") =>
    ctx.log(`[mean-reversion] ${msg}`, color);

  const interval = setInterval(() => {
    const remaining = Math.floor((ctx.slotEndMs - Date.now()) / 1000);
    if (remaining <= 0) { clearInterval(interval); release(); return; }

    const upAsk = ctx.orderBook.bestAskInfo("UP");
    const downAsk = ctx.orderBook.bestAskInfo("DOWN");
    if (!upAsk || !downAsk) return;
    const mid = (upAsk.price + downAsk.price) / 2;
    const now = Date.now();

    // Record mid
    midHistory.push({ mid, ts: now });
    const cutoff = now - cfg.spikeWindowSeconds * 1000;
    while (midHistory.length > 0 && midHistory[0].ts < cutoff) midHistory.shift();
    if (midHistory.length < 2) return;

    const oldMid = midHistory[0].mid;
    const jump = mid - oldMid;

    if (!state.entered) {
      // Spike detection: odds jumped too far too fast
      if (Math.abs(jump) < cfg.minOddsJump) return;

      const spotPrice = ctx.ticker.price;
      if (spotPrice === undefined) return;

      // Direction: spike UP → bet DOWN; spike DOWN → bet UP
      const spikeDirection: "UP" | "DOWN" = jump > 0 ? "UP" : "DOWN";
      const reversionSide: "UP" | "DOWN" = spikeDirection === "UP" ? "DOWN" : "UP";

      const entryPrice = reversionSide === "UP" ? upAsk.price : downAsk.price;
      const liq = reversionSide === "UP" ? upAsk.liquidity : downAsk.liquidity;

      // Confirm spot actually moved in opposite direction (optional)
      if (cfg.reversalConfirmationRequired) {
        const priceToBeat = ctx.getMarketResult()?.openPrice;
        if (priceToBeat === undefined) return;
        const spotMove = spotPrice - priceToBeat;
        const expectedMove = spikeDirection === "UP" ? -cfg.minPriceMovePct : cfg.minPriceMovePct;
        if (Math.abs(spotMove) < Math.abs(expectedMove)) {
          log(`no reversal confirmation yet (spotMove=${spotMove.toFixed(2)})`, "dim"); return;
        }
      }

      log(`spike detected: ${spikeDirection} jump=${jump.toFixed(3)} → reversion ${reversionSide} @ ${entryPrice.toFixed(4)}`, "cyan");
      placeBuy(ctx, state, reversionSide, entryPrice, log, () => { clearInterval(interval); release(); });
    } else {
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
  }, 300);

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
  state.entered = true; state.enteredSide = side; state.enteredAtPrice = price; state.shares = DEFAULT_SHARES;
  ctx.postOrders([{
    req: { tokenId, action: "buy", price, shares: DEFAULT_SHARES },
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

export default meanReversion;