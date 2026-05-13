import type { Strategy, StrategyContext } from "../types.ts";

/**
 * 1. Correlation Leader
 *
 * BTC leads, ETH/SOL react with delay.
 * Detect BTC direction → measure correlation → enter ETH/SOL before convergence.
 *
 * Examples:
 *   BTC UP strong + ETH still cheap on UP → buy ETH UP
 *   BTC DOWN + SOL over-reacting → buy SOL DOWN
 */
export const correlationLeader: Strategy = async (ctx) => {
  const minCorr = parseFloat(Deno.env.get("CORRELATION_MIN_CORRELATION") ?? "0.75");
  const minBtcProb = parseFloat(Deno.env.get("CORRELATION_MIN_BTC_PROB") ?? "0.55");
  const maxEntryPrice = parseFloat(Deno.env.get("CORRELATION_MAX_ENTRY_PRICE") ?? "0.45");
  const lookback = parseInt(Deno.env.get("CORRELATION_LOOKBACK_WINDOWS") ?? "10", 10);

  const release = ctx.hold();
  let lastRefresh = 0;
  let cachedBtcUpProb = 0;
  let cachedEthUpProb = 0;
  let cachedSolUpProb = 0;
  let cachedCorr = 0;

  const log = (msg: string, color: "cyan" | "green" | "yellow" | "red" | "dim" = "cyan") =>
    ctx.log(`[correlation-leader] ${msg}`, color);

  const fetchData = async () => {
    const now = Date.now();
    if (now - lastRefresh < 2000) return;
    lastRefresh = now;

    try {
      // Fetch BTC probabilities
      const btcResp = await fetch(
        `https://gamma-api.polymarket.com/events?tag_slug=btc&active=true&closed=false&limit=5`,
      );
      const btcData = await btcResp.json();
      // Parse btc market prices...
    } catch {
      // fallback
    }
  };

  ctx.postOrders([
    {
      req: {
        tokenId: ctx.clobTokenIds[0],
        action: "buy",
        price: 0.05,
        shares: 5,
      },
      expireAtMs: ctx.slotEndMs,
      onFilled(filledShares) {
        log(`BUY UP filled @ 0.05 (${filledShares} shares)`, "green");
        release();
      },
      onExpired() { log("order expired", "yellow"); release(); },
      onFailed(reason) { log(`failed: ${reason}`, "red"); release(); },
    },
  ]);

  // For now, simple placeholder that logs the strategy was invoked
  log(`correlation-leader: minCorr=${minCorr} lookback=${lookback}`, "dim");
};

export default correlationLeader;