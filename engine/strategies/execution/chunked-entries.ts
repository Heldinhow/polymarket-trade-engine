/**
 * 12. Chunked Entries / Scaling
 *
 * Não entra full size — entra em pedaços (DCA em winners).
 * Chunks: 20% / 30% / 50% ou DCA progressivo.
 */
import type { Strategy, StrategyContext } from "../types.ts";
import { Env } from "../../utils/config.ts";

type ChunkedEntriesConfig = {
  enabled: boolean;
  chunks: number[];              // e.g. [0.2, 0.3, 0.5] = 20%, then 30%, then 50%
  chunkDelayMs: number;          // delay between chunks
  maxTotalChunks: number;
  dcaOnWinner: boolean;         // add more on profit, or only on initial
  maxEntryPrice: number;
  stopLossPct: number;
  takeProfitPct: number;
};

function loadConfig(): ChunkedEntriesConfig {
  const rawChunks = Env.get("CHUNKED_ENTRY_CHUNKS") ?? "0.2,0.3,0.3,0.2";
  return {
    enabled: Env.get("ENABLE_CHUNKED_ENTRIES") !== "false",
    chunks: rawChunks.split(",").map(Number),
    chunkDelayMs: parseInt(Env.get("CHUNKED_ENTRY_DELAY_MS") ?? "5000", 10),
    maxTotalChunks: parseInt(Env.get("CHUNKED_ENTRY_MAX_CHUNKS") ?? "4", 10),
    dcaOnWinner: Env.get("CHUNKED_ENTRY_DCA_WINNER") === "true",
    maxEntryPrice: parseFloat(Env.get("CHUNKED_ENTRY_MAX_PRICE") ?? "0.45"),
    stopLossPct: parseFloat(Env.get("CHUNKED_ENTRY_STOP_LOSS_PCT") ?? "0.35"),
    takeProfitPct: parseFloat(Env.get("CHUNKED_ENTRY_TAKE_PROFIT_PCT") ?? "0.5"),
  };
}

type State = {
  enteredSide: "UP" | "DOWN" | null;
  totalShares: number;
  avgPrice: number;
  chunksPlaced: number;
  totalFilled: number;
};

export const chunkedEntries: Strategy = async (ctx) => {
  if (!Env.get("DRY_RUN_ENABLED")) { ctx.log("[chunked-entries] DRY_RUN_REQUIRED", "red"); process.exit(1); }
  const cfg = loadConfig();
  if (!cfg.enabled) { ctx.log("[chunked-entries] disabled", "dim"); return; }

  const release = ctx.hold();
  const state: State = { enteredSide: null, totalShares: 0, avgPrice: 0, chunksPlaced: 0, totalFilled: 0 };

  const log = (msg: string, color: "cyan" | "green" | "yellow" | "red" | "dim" = "cyan") =>
    ctx.log(`[chunked-entries] ${msg}`, color);

  let decided = false;
  let decidedSide: "UP" | "DOWN" = "UP";
  let decidedEntryPrice = 0;

  const placeChunk = (chunkIdx: number) => {
    if (chunkIdx >= cfg.chunks.length || chunkIdx >= cfg.maxTotalChunks) return;
    const chunkPct = cfg.chunks[chunkIdx];
    const shares = Math.max(1, Math.round(6 * chunkPct));
    const tokenId = decidedSide === "UP" ? ctx.clobTokenIds[0] : ctx.clobTokenIds[1];
    const price = decidedEntryPrice;

    log(`chunk ${chunkIdx + 1}/${cfg.chunks.length}: ${(chunkPct * 100).toFixed(0)}% = ${shares} shares @ ${price.toFixed(4)}`, "cyan");

    ctx.postOrders([{
      req: { tokenId, action: "buy", price, shares },
      expireAtMs: ctx.slotEndMs,
      onFilled(filledShares) {
        const cost = price * filledShares;
        const prevTotal = state.avgPrice * state.totalFilled;
        state.totalFilled += filledShares;
        state.avgPrice = (prevTotal + cost) / state.totalFilled;
        state.chunksPlaced++;
        log(`chunk ${chunkIdx + 1} filled (${filledShares}) — avg price now ${state.avgPrice.toFixed(4)}`, "green");

        if (state.chunksPlaced < cfg.chunks.length && state.chunksPlaced < cfg.maxTotalChunks) {
          setTimeout(() => placeChunk(state.chunksPlaced), cfg.chunkDelayMs);
        }
      },
      onExpired() { log(`chunk ${chunkIdx + 1} expired`, "yellow"); scheduleNextChunk(); },
      onFailed(r) { log(`chunk ${chunkIdx + 1} failed: ${r}`, "red"); scheduleNextChunk(); },
    }]);
  };

  const scheduleNextChunk = () => {
    if (state.chunksPlaced < cfg.chunks.length && state.chunksPlaced < cfg.maxTotalChunks) {
      setTimeout(() => placeChunk(state.chunksPlaced), cfg.chunkDelayMs);
    } else {
      log("all chunks placed", "green");
    }
  };

  const interval = setInterval(() => {
    const remaining = Math.floor((ctx.slotEndMs - Date.now()) / 1000);
    if (remaining <= 0) { clearInterval(interval); release(); return; }

    if (!decided) {
      const upAsk = ctx.orderBook.bestAskInfo("UP");
      const downAsk = ctx.orderBook.bestAskInfo("DOWN");
      if (!upAsk || !downAsk) return;

      // Simple: pick cheaper side with enough liquidity
      const candidates: Array<{ side: "UP" | "DOWN"; price: number }> = [];
      if (upAsk.price <= cfg.maxEntryPrice) candidates.push({ side: "UP", price: upAsk.price });
      if (downAsk.price <= cfg.maxEntryPrice) candidates.push({ side: "DOWN", price: downAsk.price });
      if (candidates.length === 0) return;

      candidates.sort((a, b) => a.price - b.price);
      decidedSide = candidates[0].side;
      decidedEntryPrice = candidates[0].price;
      decided = true;
      state.enteredSide = decidedSide;

      log(`decided: ${decidedSide} @ ${decidedEntryPrice.toFixed(4)} — starting chunked entry`, "cyan");
      placeChunk(0);
    } else {
      // Manage position
      if (state.totalFilled === 0) return;
      const posSide = state.enteredSide!;
      const currentAsk = ctx.orderBook.bestAskInfo(posSide)?.price ?? 0;
      if (currentAsk === 0) return;
      const pnlPct = ((currentAsk - state.avgPrice) / state.avgPrice) * (posSide === "UP" ? 1 : -1);

      // DCA: add more chunks if winner and dcaOnWinner
      if (cfg.dcaOnWinner && pnlPct > 0 && state.chunksPlaced < cfg.maxTotalChunks) {
        const liq = ctx.orderBook.bestAskInfo(posSide)?.liquidity ?? 0;
        if (liq > 100) {
          setTimeout(() => placeChunk(state.chunksPlaced), cfg.chunkDelayMs);
        }
      }

      if (pnlPct >= cfg.takeProfitPct) {
        const bestBid = ctx.orderBook.bestBidPrice(posSide) ?? currentAsk - 0.01;
        log(`TP @ ${bestBid.toFixed(4)} avg=${state.avgPrice.toFixed(4)} (+${(pnlPct * 100).toFixed(1)}%)`, "green");
        placeSell(ctx, state, bestBid, log, () => { clearInterval(interval); release(); });
      } else if (pnlPct <= -cfg.stopLossPct) {
        const bestBid = ctx.orderBook.bestBidPrice(posSide) ?? currentAsk - 0.01;
        log(`SL @ ${bestBid.toFixed(4)} avg=${state.avgPrice.toFixed(4)} (${(pnlPct * 100).toFixed(1)}%)`, "red");
        placeSell(ctx, state, bestBid, log, () => { clearInterval(interval); release(); });
      } else if (remaining <= 5) {
        const bestBid = ctx.orderBook.bestBidPrice(posSide) ?? currentAsk;
        log(`timeout — closing`, "yellow");
        placeSell(ctx, state, bestBid, log, () => { clearInterval(interval); release(); });
      }
    }
  }, 500);

  return () => clearInterval(interval);
};

function placeSell(ctx: StrategyContext, state: State, price: number,
  log: (msg: string, color?: "cyan" | "green" | "yellow" | "red" | "dim") => void, onDone: () => void) {
  const posSide = state.enteredSide!;
  const tokenId = posSide === "UP" ? ctx.clobTokenIds[0] : ctx.clobTokenIds[1];
  ctx.postOrders([{ req: { tokenId, action: "sell", price, shares: state.totalFilled }, expireAtMs: ctx.slotEndMs,
    onFilled() { log(`SELL @ ${price} (${state.totalFilled} shares)`, "green"); onDone(); },
    onExpired() { log("sell expired", "red"); ctx.emergencySells(ctx.pendingOrders.filter(o => o.action === "sell").map(o => o.orderId)); onDone(); },
  }]);
}

export default chunkedEntries;