import type { Strategy } from "./types.ts";
import { assetFromSlug } from "./utils/correlation.ts";
import {
  fetchBTCProbabilities,
  computeSyncRate,
  type BTCProbs,
  type SyncData,
} from "./utils/correlation.ts";

const envNum = (k: string, d: number): number => {
  const r = process.env[k];
  if (r === undefined) return d;
  const p = parseFloat(r);
  return Number.isFinite(p) ? p : d;
};

const MIN_DIVERGENCE = envNum("ETH_BTC_CORR_MIN_DIVERGENCE", 0.2);
const SYNC_LOOKBACK = envNum("ETH_BTC_CORR_SYNC_LOOKBACK", 5);
const SYNC_THRESHOLD = envNum("ETH_BTC_CORR_SYNC_THRESHOLD", 0.8);
const MAX_ENTRY_PRICE = envNum("ETH_BTC_CORR_MAX_ENTRY_PRICE", 0.4);
const SHARES = envNum("ETH_BTC_CORR_SHARES", 10);
const STOP_SEC = envNum("ETH_BTC_CORR_STOP_SEC", 30);
const REFRESH_MS = envNum("ETH_BTC_CORR_REFRESH_MS", 1000);
const SYNC_REFRESH_MS = envNum("ETH_BTC_CORR_SYNC_REFRESH_MS", 60000);
const TP_MULTIPLIER = envNum("ETH_BTC_CORR_TP_MULTIPLIER", 1.5);
const MAX_TRADES_PER_MARKET = envNum("ETH_BTC_CORR_MAX_TRADES_PER_MARKET", 1);

type TpState = {
  entryPending: boolean;
  tradesOpened: number;
  position: {
    side: "UP" | "DOWN";
    tokenId: string;
    shares: number;
    entryPrice: number;
  } | null;
  release: (() => void) | null;
};

export function tpPrice(
  entryPrice: number,
  multiplier = TP_MULTIPLIER,
): number {
  return Math.round(entryPrice * multiplier * 100) / 100;
}

export function canEnterNextTrade(
  state: { entryPending: boolean; hasPosition: boolean; tradesOpened: number },
  maxTrades: number,
): boolean {
  return (
    !state.entryPending && !state.hasPosition && state.tradesOpened < maxTrades
  );
}

export function checkEntry(params: {
  btcUpProb: number;
  btcDownProb: number;
  ethUp: { price: number; liquidity: number } | null;
  ethDown: { price: number; liquidity: number } | null;
  syncData: SyncData | null;
  syncThreshold: number;
  minDivergence?: number;
  maxEntryPrice?: number;
  shares?: number;
}): { side: "UP" | "DOWN"; ask: number } | null {
  const { btcUpProb, btcDownProb, ethUp, ethDown, syncData, syncThreshold } =
    params;
  const minDivergence = params.minDivergence ?? MIN_DIVERGENCE;
  const maxEntryPrice = params.maxEntryPrice ?? MAX_ENTRY_PRICE;
  const shares = params.shares ?? SHARES;

  if (syncData && syncData.syncRate < syncThreshold) return null;

  const btcDominant = btcUpProb >= btcDownProb ? "UP" : "DOWN";
  const btcDominantProb = btcDominant === "UP" ? btcUpProb : btcDownProb;

  const ethInfo = btcDominant === "UP" ? ethUp : ethDown;
  if (!ethInfo) return null;

  const divergence = btcDominantProb - ethInfo.price;
  if (divergence < minDivergence) return null;
  if (ethInfo.price > maxEntryPrice) return null;
  if (ethInfo.liquidity < ethInfo.price * shares) return null;

  return { side: btcDominant, ask: ethInfo.price };
}

export const ethBtcCorrelationTp: Strategy = async (ctx) => {
  const asset = assetFromSlug(ctx.slug);
  if (asset !== "eth") {
    ctx.log(
      `[eth-btc-correlation-tp] unsupported asset "${asset}" — requires MARKET_ASSET=eth`,
      "yellow",
    );
    return;
  }

  const state: TpState = {
    entryPending: false,
    tradesOpened: 0,
    position: null,
    release: ctx.hold(),
  };

  let cachedBtc: BTCProbs | null = null;
  let cachedSync: SyncData | null = null;
  let lastBtcFetch = 0;
  let lastSyncRefresh = 0;

  const timers: ReturnType<typeof setTimeout>[] = [];

  ctx.log(
    `[eth-btc-correlation-tp] divergence >= $${MIN_DIVERGENCE.toFixed(2)}, max entry $${MAX_ENTRY_PRICE.toFixed(2)}, TP ${TP_MULTIPLIER.toFixed(2)}x, max trades ${MAX_TRADES_PER_MARKET}, sync ${(SYNC_THRESHOLD * 100).toFixed(0)}%/${SYNC_LOOKBACK}w, stop ${STOP_SEC}s`,
    "dim",
  );

  const stopStrategy = () => {
    clearInterval(tickInterval);
    state.release?.();
    state.release = null;
  };

  const tickInterval = setInterval(() => {
    const remaining = Math.floor((ctx.slotEndMs - Date.now()) / 1000);

    if (remaining <= 0) {
      clearInterval(tickInterval);
      return;
    }

    if (remaining <= 5 && !state.entryPending && !state.position) {
      stopStrategy();
      return;
    }

    if (
      !canEnterNextTrade(
        {
          entryPending: state.entryPending,
          hasPosition: state.position !== null,
          tradesOpened: state.tradesOpened,
        },
        MAX_TRADES_PER_MARKET,
      )
    ) {
      if (
        state.tradesOpened >= MAX_TRADES_PER_MARKET &&
        !state.entryPending &&
        !state.position
      ) {
        ctx.log(
          `[eth-btc-correlation-tp] max trades reached (${state.tradesOpened}/${MAX_TRADES_PER_MARKET})`,
          "dim",
        );
        stopStrategy();
      }
      return;
    }

    const now = Date.now();

    if (now - lastBtcFetch >= REFRESH_MS) {
      lastBtcFetch = now;
      fetchBTCProbabilities(ctx.slotEndMs / 1000).then((p) => {
        cachedBtc = p;
      });
    }

    if (now - lastSyncRefresh >= SYNC_REFRESH_MS) {
      lastSyncRefresh = now;
      computeSyncRate("eth", SYNC_LOOKBACK).then((s) => {
        cachedSync = s;
        if (s) {
          ctx.setTelemetry({
            sync: {
              syncRate: s.syncRate,
              concordant: s.concordant,
              divergent: s.divergent,
            },
          });
          ctx.log(
            `[eth-btc-correlation-tp] sync rate ${(s.syncRate * 100).toFixed(0)}% (${s.concordant}c/${s.divergent}d)`,
            "dim",
          );
        }
      });
    }

    if (!cachedBtc) return;

    const btcDominant =
      cachedBtc.btcUpProb >= cachedBtc.btcDownProb ? "UP" : "DOWN";
    const btcDominantProb =
      btcDominant === "UP" ? cachedBtc.btcUpProb : cachedBtc.btcDownProb;
    const ethDominantInfo =
      btcDominant === "UP"
        ? ctx.orderBook.bestAskInfo("UP")
        : ctx.orderBook.bestAskInfo("DOWN");

    if (ethDominantInfo) {
      ctx.setTelemetry({
        signal: {
          baseAsset: "BTC",
          targetAsset: "ETH",
          side: btcDominant,
          basePrice: btcDominantProb,
          targetPrice: ethDominantInfo.price,
          difference: parseFloat(
            (btcDominantProb - ethDominantInfo.price).toFixed(4),
          ),
        },
      });
    }

    const signal = checkEntry({
      btcUpProb: cachedBtc.btcUpProb,
      btcDownProb: cachedBtc.btcDownProb,
      ethUp: ctx.orderBook.bestAskInfo("UP"),
      ethDown: ctx.orderBook.bestAskInfo("DOWN"),
      syncData: cachedSync,
      syncThreshold: SYNC_THRESHOLD,
    });

    if (!signal) return;

    state.entryPending = true;

    const tokenId =
      signal.side === "UP" ? ctx.clobTokenIds[0] : ctx.clobTokenIds[1];
    const targetTp = tpPrice(signal.ask);

    ctx.log(
      `[eth-btc-correlation-tp] signal ${signal.side} @ ${signal.ask.toFixed(4)}, TP ${targetTp.toFixed(4)} (${TP_MULTIPLIER.toFixed(2)}x), div ${(btcDominantProb - signal.ask).toFixed(3)}`,
      "cyan",
    );

    ctx.postOrders([
      {
        req: { tokenId, action: "buy", price: signal.ask, shares: SHARES },
        expireAtMs: ctx.slotEndMs,
        onFilled(filledShares) {
          const actualEntry = signal.ask;
          const sellPrice = tpPrice(actualEntry);

          state.entryPending = false;
          state.tradesOpened++;
          state.position = {
            side: signal.side,
            tokenId,
            shares: filledShares,
            entryPrice: actualEntry,
          };
          ctx.setTelemetry({
            position: {
              side: signal.side,
              shares: filledShares,
              entryPrice: actualEntry,
            },
          });

          ctx.log(
            `[eth-btc-correlation-tp] BUY ${signal.side} filled @ ${actualEntry.toFixed(4)} (${filledShares} shares)`,
            "green",
          );

          const buyCost = actualEntry * filledShares;
          const sellRevenue = sellPrice * filledShares;
          const tradePnl = parseFloat((sellRevenue - buyCost).toFixed(4));

          ctx.postOrders([
            {
              req: {
                tokenId,
                action: "sell",
                price: sellPrice,
                shares: filledShares,
              },
              expireAtMs: ctx.slotEndMs,
              onFilled() {
                state.position = null;
                ctx.setTelemetry({ position: null });
                ctx.log(
                  `[eth-btc-correlation-tp] SELL ${signal.side} @ ${sellPrice.toFixed(4)} filled — TP complete (${state.tradesOpened}/${MAX_TRADES_PER_MARKET}) — PnL: ${tradePnl >= 0 ? "+" : ""}$${tradePnl.toFixed(2)}`,
                  "green",
                );
                if (state.tradesOpened >= MAX_TRADES_PER_MARKET) {
                  stopStrategy();
                }
              },
              onExpired() {
                ctx.log(
                  `[eth-btc-correlation-tp] SELL ${signal.side} @ ${sellPrice.toFixed(4)} expired — emergency selling`,
                  "red",
                );
                const sellIds = ctx.pendingOrders
                  .filter((o) => o.action === "sell")
                  .map((o) => o.orderId);
                if (sellIds.length > 0) ctx.emergencySells(sellIds);
              },
              onFailed(reason) {
                ctx.log(
                  `[eth-btc-correlation-tp] SELL ${signal.side} @ ${sellPrice.toFixed(4)} failed (${reason})`,
                  "red",
                );
              },
            },
          ]);

          const emergencyMs = ctx.slotEndMs - STOP_SEC * 1000 - Date.now();
          if (emergencyMs > 0) {
            timers.push(
              setTimeout(() => {
                if (state.position) {
                  ctx.log(
                    `[eth-btc-correlation-tp] ${STOP_SEC}s before end — emergency selling ${state.position.side}`,
                    "red",
                  );
                  const sellIds = ctx.pendingOrders
                    .filter((o) => o.action === "sell")
                    .map((o) => o.orderId);
                  if (sellIds.length > 0) ctx.emergencySells(sellIds);
                }
              }, emergencyMs),
            );
          }
        },
        onExpired() {
          ctx.log(
            `[eth-btc-correlation-tp] BUY ${signal.side} @ ${signal.ask.toFixed(4)} expired`,
            "yellow",
          );
          state.entryPending = false;
        },
        onFailed(reason) {
          ctx.log(
            `[eth-btc-correlation-tp] BUY ${signal.side} @ ${signal.ask.toFixed(4)} failed (${reason})`,
            "red",
          );
          state.entryPending = false;
        },
      },
    ]);
  }, 100);

  return () => {
    clearInterval(tickInterval);
    for (const t of timers) clearTimeout(t);
    state.release?.();
    state.release = null;
  };
};
