/**
 * 14. Timeout Exit
 *
 * Sai antes da resolução natural do mercado.
 * Evita:
 *   - caos final
 *   - volatilidade absurda perto do fechamento
 *   - slippage em momentos de baixa liquidity
 *
 * Config: `TIMEOUT_EXIT_SECONDS` — quantos segundos antes do fim sair.
 * Recomendado: 15-30 segundos para mercados <5m
 */
import type { Strategy, StrategyContext } from "../types.ts";
import { Env } from "../../../utils/config.ts";

type TimeoutExitConfig = {
  enabled: boolean;
  exitSecondsBefore: number;     // exit this many seconds before slotEndMs
  minProfitPct: number;          // only exit if profit >= this (null = always exit)
  trailingStop: boolean;         // use trailing stop as safety
  trailingActivationPct: number;
  trailingStepPct: number;
};

function loadConfig(): TimeoutExitConfig {
  return {
    enabled: Env.get("ENABLE_TIMEOUT_EXIT") !== "false",
    exitSecondsBefore: parseInt(Env.get("TIMEOUT_EXIT_SECONDS") ?? "15", 10),
    minProfitPct: parseFloat(Env.get("TIMEOUT_EXIT_MIN_PROFIT_PCT") ?? "0"),
    trailingStop: Env.get("TIMEOUT_EXIT_TRAILING") === "true",
    trailingActivationPct: parseFloat(Env.get("TIMEOUT_EXIT_TRAILING_ACTIVATE") ?? "0.08"),
    trailingStepPct: parseFloat(Env.get("TIMEOUT_EXIT_TRAILING_STEP") ?? "0.03"),
  };
}

type State = {
  active: boolean;
  enteredSide: "UP" | "DOWN" | null;
  entryPrice: number;
  shares: number;
  trailingActivated: boolean;
  peakProfit: number;
  exitFired: boolean;
};

export const timeoutExit: Strategy = async (ctx) => {
  if (!Env.get("DRY_RUN_ENABLED")) { ctx.log("[timeout-exit] DRY_RUN_REQUIRED", "red"); process.exit(1); }
  const cfg = loadConfig();
  if (!cfg.enabled) { ctx.log("[timeout-exit] disabled", "dim"); return; }

  const release = ctx.hold();
  const state: State = {
    active: false, enteredSide: null, entryPrice: 0, shares: 0,
    trailingActivated: false, peakProfit: 0, exitFired: false,
  };

  const log = (msg: string, color: "cyan" | "green" | "yellow" | "red" | "dim" = "cyan") =>
    ctx.log(`[timeout-exit] ${msg}`, color);

  const interval = setInterval(() => {
    const remaining = Math.floor((ctx.slotEndMs - Date.now()) / 1000);

    // ── Timeout exit: close position before slot end ──────────────────────
    if (remaining <= cfg.exitSecondsBefore && state.active && !state.exitFired) {
      const posSide = state.enteredSide!;
      const currentBid = ctx.orderBook.bestBidPrice(posSide);
      const currentAsk = ctx.orderBook.bestAskInfo(posSide)?.price ?? 0;
      if (currentBid === null && currentAsk === 0) return;

      const sellPrice = currentBid ?? currentAsk;
      const profit = posSide === "UP"
        ? (sellPrice - state.entryPrice) / state.entryPrice
        : (state.entryPrice - sellPrice) / state.entryPrice;

      log(`timeout-exit: closing ${posSide} @ ${sellPrice.toFixed(4)} (${(profit * 100).toFixed(1)}% profit) ${remaining}s before close`, "yellow");
      placeSell(ctx, state, sellPrice, log, () => { state.exitFired = true; clearInterval(interval); release(); });
      return;
    }

    if (remaining <= 0) { clearInterval(interval); release(); return; }

    // ── Entry ──────────────────────────────────────────────────────────────
    if (!state.active) {
      const upAsk = ctx.orderBook.bestAskInfo("UP");
      const downAsk = ctx.orderBook.bestAskInfo("DOWN");
      if (!upAsk || !downAsk) return;

      // Simple: enter on any decent price < 0.5
      const candidates: Array<{ side: "UP" | "DOWN"; price: number }> = [];
      if (upAsk.price <= 0.45) candidates.push({ side: "UP", price: upAsk.price });
      if (downAsk.price <= 0.45) candidates.push({ side: "DOWN", price: downAsk.price });
      if (candidates.length === 0) return;

      candidates.sort((a, b) => a.price - b.price);
      const chosen = candidates[0];

      state.active = true; state.enteredSide = chosen.side;
      state.entryPrice = chosen.price; state.shares = 6;

      log(`entry ${chosen.side} @ ${chosen.price.toFixed(4)} — timeout-exit active (exit in ${cfg.exitSecondsBefore}s)`, "cyan");

      const tokenId = chosen.side === "UP" ? ctx.clobTokenIds[0] : ctx.clobTokenIds[1];
      ctx.postOrders([{
        req: { tokenId, action: "buy", price: chosen.price, shares: 6 },
        expireAtMs: ctx.slotEndMs,
        onFilled(filledShares) { log(`filled (${filledShares})`, "green"); },
        onExpired() { log("entry expired", "yellow"); state.active = false; clearInterval(interval); release(); },
        onFailed(r) { log(`failed: ${r}`, "red"); state.active = false; clearInterval(interval); release(); },
      }]);
    } else {
      // ── Manage open position ──────────────────────────────────────────────
      const posSide = state.enteredSide!;
      const currentAsk = ctx.orderBook.bestAskInfo(posSide)?.price ?? 0;
      if (currentAsk === 0) return;

      const profit = posSide === "UP"
        ? (currentAsk - state.entryPrice) / state.entryPrice
        : (state.entryPrice - currentAsk) / state.entryPrice;

      // Track peak profit
      if (profit > state.peakProfit) state.peakProfit = profit;

      // Trailing stop
      if (cfg.trailingStop && !state.trailingActivated && profit >= cfg.trailingActivationPct) {
        state.trailingActivated = true;
        log(`trailing stop activated @ ${(profit * 100).toFixed(1)}%`, "cyan");
      }

      if (cfg.trailingStop && state.trailingActivated) {
        const trailSteps = Math.floor((state.peakProfit - profit) / cfg.trailingStepPct);
        if (trailSteps >= 1 && !state.exitFired) {
          log(`trailing stop triggered — profit dropped from ${(state.peakProfit * 100).toFixed(1)}% to ${(profit * 100).toFixed(1)}%`, "red");
          const sellPrice = ctx.orderBook.bestBidPrice(posSide) ?? currentAsk - 0.01;
          placeSell(ctx, state, sellPrice, log, () => { state.exitFired = true; clearInterval(interval); release(); });
        }
      }

      // Min profit check for timeout exit
      if (remaining <= cfg.exitSecondsBefore && profit >= cfg.minProfitPct && !state.exitFired) {
        const sellPrice = ctx.orderBook.bestBidPrice(posSide) ?? currentAsk;
        log(`timeout-exit (profit check passed: ${(profit * 100).toFixed(1)}% >= ${(cfg.minProfitPct * 100).toFixed(0)}%)`, "yellow");
        placeSell(ctx, state, sellPrice, log, () => { state.exitFired = true; clearInterval(interval); release(); });
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
    onFilled() { log(`SELL @ ${price} filled`, "green"); state.active = false; onDone(); },
    onExpired() { log("sell expired", "red"); ctx.emergencySells(ctx.pendingOrders.filter(o => o.action === "sell").map(o => o.orderId)); state.active = false; onDone(); },
  }]);
}

export default timeoutExit;