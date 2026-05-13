/**
 * 13. Dynamic Stop Loss
 *
 * Stop muda conforme contexto:
 *   - Tendência favorece posição → stop mais largo
 *   - Mercado virou → stop agressivo
 *
 * Esta estratégia é um WRAPPER — combina com qualquer direção.
 * Usa ctx.hold() para monitorizar e ajustar stop dinamicamente.
 */
import type { Strategy, StrategyContext } from "../types.ts";
import { Env } from "../../../utils/config.ts";

type DynamicStopConfig = {
  enabled: boolean;
  // Narrow stop (aggressive) — used when market reverses against us
  narrowStopPct: number;
  // Wide stop (relaxed) — used when momentum is with us
  wideStopPct: number;
  // Threshold: if momentum score > this, use wide stop
  momentumWideThreshold: number;
  // ATR multiplier for dynamic stop calculation
  atrMultiplier: number;
  // Trailing: move stop in favor once profit > this
  trailingActivationPct: number;
  trailingStepPct: number;
};

function loadConfig(): DynamicStopConfig {
  return {
    enabled: Env.get("ENABLE_DYNAMIC_STOP") !== "false",
    narrowStopPct: parseFloat(Env.get("DYNAMIC_STOP_NARROW_PCT") ?? "0.15"),
    wideStopPct: parseFloat(Env.get("DYNAMIC_STOP_WIDE_PCT") ?? "0.35"),
    momentumWideThreshold: parseFloat(Env.get("DYNAMIC_STOP_MOMENTUM_THRESHOLD") ?? "0.5"),
    atrMultiplier: parseFloat(Env.get("DYNAMIC_STOP_ATR_MULTIPLIER") ?? "2.0"),
    trailingActivationPct: parseFloat(Env.get("DYNAMIC_STOP_TRAILING_ACTIVATE") ?? "0.1"),
    trailingStepPct: parseFloat(Env.get("DYNAMIC_STOP_TRAILING_STEP") ?? "0.05"),
  };
}

type ATR = { period: number; values: number[]; current: number | null };

function newATR(period = 14): ATR {
  return { period, values: [], current: null };
}

function updateATR(atr: ATR, price: number): void {
  if (atr.values.length === 0) { atr.values.push(price); return; }
  const tr = Math.abs(price - atr.values[atr.values.length - 1]);
  atr.values.push(tr);
  if (atr.values.length > atr.period) atr.values.shift();
  atr.current = atr.values.reduce((a, b) => a + b, 0) / atr.values.length;
}

// ── ATR helper already in late-entry, but we define it here for dynamic stop ──

type State = {
  active: boolean;
  enteredSide: "UP" | "DOWN" | null;
  entryPrice: number;
  shares: number;
  currentStop: number;
  bestBidSinceEntry: number;
  trailingActivated: boolean;
};

export const dynamicStop: Strategy = async (ctx) => {
  if (!Env.get("DRY_RUN_ENABLED")) { ctx.log("[dynamic-stop] DRY_RUN_REQUIRED", "red"); process.exit(1); }
  const cfg = loadConfig();
  if (!cfg.enabled) { ctx.log("[dynamic-stop] disabled", "dim"); return; }

  const release = ctx.hold();
  const state: State = {
    active: false, enteredSide: null, entryPrice: 0, shares: 0,
    currentStop: 0, bestBidSinceEntry: 0, trailingActivated: false,
  };
  const atr = newATR(14);
  const priceHistory: number[] = [];

  const log = (msg: string, color: "cyan" | "green" | "yellow" | "red" | "dim" = "cyan") =>
    ctx.log(`[dynamic-stop] ${msg}`, color);

  // ── Entry: wait for a clear signal from order book ──────────────────────────
  const interval = setInterval(() => {
    const remaining = Math.floor((ctx.slotEndMs - Date.now()) / 1000);
    if (remaining <= 0) { clearInterval(interval); release(); return; }

    const price = ctx.ticker.price;
    if (price !== undefined) {
      priceHistory.push(price);
      updateATR(atr, price);
      if (priceHistory.length > 50) priceHistory.shift();
    }

    // ── Position management ────────────────────────────────────────────────────
    if (state.active && state.enteredSide) {
      const posSide = state.enteredSide;
      const currentAsk = ctx.orderBook.bestAskInfo(posSide)?.price ?? 0;
      const currentBid = ctx.orderBook.bestBidPrice(posSide);
      if (currentAsk === 0) return;

      const profit = posSide === "UP"
        ? (currentAsk - state.entryPrice) / state.entryPrice
        : (state.entryPrice - currentAsk) / state.entryPrice;

      // Track best bid for trailing
      if (currentBid !== null && currentBid > state.bestBidSinceEntry) {
        state.bestBidSinceEntry = currentBid;
      }

      // Trailing activation
      if (!state.trailingActivated && profit >= cfg.trailingActivationPct) {
        state.trailingActivated = true;
        log(`trailing activated @ profit ${(profit * 100).toFixed(1)}%`, "cyan");
      }

      // ── Compute dynamic stop ─────────────────────────────────────────────────
      const momentum = computeMomentum(priceHistory);
      let stopDistance: number;

      if (momentum !== null && momentum >= cfg.momentumWideThreshold) {
        // Momentum with us → wider stop
        stopDistance = cfg.wideStopPct;
        if (atr.current !== null) stopDistance = Math.max(stopDistance, atr.current * cfg.atrMultiplier / state.entryPrice);
      } else {
        stopDistance = cfg.narrowStopPct;
      }

      // Trailing: tighten stop as profit grows
      if (state.trailingActivated) {
        const trailTighten = Math.floor(profit / cfg.trailingActivationPct) * cfg.trailingStepPct;
        stopDistance = Math.max(0.05, stopDistance - trailTighten);
      }

      const newStop = posSide === "UP"
        ? state.entryPrice * (1 - stopDistance)
        : state.entryPrice * (1 + stopDistance);

      // Update stop if it moved in our favor
      if (posSide === "UP" ? newStop > state.currentStop : newStop < state.currentStop) {
        state.currentStop = newStop;
        log(`stop updated to ${state.currentStop.toFixed(4)} (dist=${(stopDistance * 100).toFixed(1)}%, momentum=${momentum?.toFixed(2) ?? "n/a"})`, "dim");
      }

      // ── Check exit ───────────────────────────────────────────────────────────
      const stopTriggered = posSide === "UP"
        ? currentAsk <= state.currentStop
        : currentAsk >= state.currentStop;

      if (stopTriggered) {
        const sellPrice = currentBid ?? (posSide === "UP" ? currentAsk - 0.01 : currentAsk + 0.01);
        log(`dynamic stop triggered @ ${sellPrice.toFixed(4)} (profit=${(profit * 100).toFixed(1)}%, trailing=${state.trailingActivated})`, "red");
        placeSell(ctx, state, sellPrice, log, () => { clearInterval(interval); release(); });
      } else if (remaining <= 5) {
        const sellPrice = currentBid ?? currentAsk;
        log(`timeout exit @ ${sellPrice.toFixed(4)}`, "yellow");
        placeSell(ctx, state, sellPrice, log, () => { clearInterval(interval); release(); });
      }
    } else {
      // ── Look for entry ───────────────────────────────────────────────────────
      const upAsk = ctx.orderBook.bestAskInfo("UP");
      const downAsk = ctx.orderBook.bestAskInfo("DOWN");
      if (!upAsk || !downAsk) return;

      // Simple entry: strong imbalance + momentum
      const upLiq = upAsk.liquidity, downLiq = downAsk.liquidity;
      const imbalance = Math.abs(upLiq - downLiq) / (upLiq + downLiq + 0.001);
      const mom = computeMomentum(priceHistory);

      if (imbalance > 0.3 && mom !== null && Math.abs(mom) > 0.05) {
        const side: "UP" | "DOWN" = upLiq > downLiq ? "UP" : "DOWN";
        const entryPrice = side === "UP" ? upAsk.price : downAsk.price;
        if (entryPrice > 0.5) { log(`price too high ${entryPrice.toFixed(3)}`, "dim"); return; }

        state.active = true; state.enteredSide = side;
        state.entryPrice = entryPrice; state.shares = 6;
        state.currentStop = side === "UP"
          ? entryPrice * (1 - cfg.wideStopPct)
          : entryPrice * (1 + cfg.wideStopPct);
        state.bestBidSinceEntry = entryPrice;

        log(`entry ${side} @ ${entryPrice} — initial stop ${state.currentStop.toFixed(4)}`, "cyan");

        const tokenId = side === "UP" ? ctx.clobTokenIds[0] : ctx.clobTokenIds[1];
        ctx.postOrders([{
          req: { tokenId, action: "buy", price: entryPrice, shares: 6 },
          expireAtMs: ctx.slotEndMs,
          onFilled(filledShares) { log(`entry filled (${filledShares})`, "green"); },
          onExpired() { log("entry expired", "yellow"); state.active = false; clearInterval(interval); release(); },
          onFailed(r) { log(`entry failed: ${r}`, "red"); state.active = false; clearInterval(interval); release(); },
        }]);
      }
    }
  }, 300);

  return () => clearInterval(interval);
};

function computeMomentum(history: number[]): number | null {
  if (history.length < 10) return null;
  const recent = history.slice(-5);
  const older = history.slice(-10, -5);
  const avgRecent = recent.reduce((a, b) => a + b, 0) / recent.length;
  const avgOlder = older.reduce((a, b) => a + b, 0) / older.length;
  return (avgRecent - avgOlder) / (avgOlder + 0.001);
}

function placeSell(ctx: StrategyContext, state: State, price: number,
  log: (msg: string, color?: "cyan" | "green" | "yellow" | "red" | "dim") => void, onDone: () => void) {
  const posSide = state.enteredSide!;
  const tokenId = posSide === "UP" ? ctx.clobTokenIds[0] : ctx.clobTokenIds[1];
  ctx.postOrders([{ req: { tokenId, action: "sell", price, shares: state.shares }, expireAtMs: ctx.slotEndMs,
    onFilled() { log(`SELL @ ${price} filled`, "green"); state.active = false; onDone(); },
    onExpired() { log("sell expired", "red"); ctx.emergencySells(ctx.pendingOrders.filter(o => o.action === "sell").map(o => o.orderId)); state.active = false; onDone(); },
  }]);
}

export default dynamicStop;