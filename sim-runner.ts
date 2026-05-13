/**
 * sim-runner.ts
 *
 * Standalone simulation runner for polymarket-trade-engine strategies.
 * Runs a single strategy in dry-run mode against the real Polymarket CLOB API.
 *
 * Usage:
 *   bun sim-runner.ts --strategy near-resolution --rounds 20 --rounds 20
 *   SIM_STATE_FILE=state/sim-runs/my-run.json bun sim-runner.ts --strategy momentum-continuation --rounds 20
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

// ── Strategy Loader ────────────────────────────────────────────────────────────

async function loadStrategy(name: string) {
  const paths: Record<string, string> = {
    "simulation": "./engine/strategy/simulation.ts",
    "late-entry": "./engine/strategy/late-entry.ts",
    "two-sided-tp": "./engine/strategy/two-sided-tp.ts",
    "eth-btc-correlation-tp": "./engine/strategy/eth-btc-correlation-tp.ts",
    "correlation-leader": "./engine/strategies/direction/correlation-leader.ts",
    "near-resolution": "./engine/strategies/direction/near-resolution.ts",
    "momentum-continuation": "./engine/strategies/direction/momentum-continuation.ts",
    "mean-reversion": "./engine/strategies/direction/mean-reversion.ts",
    "clob-momentum": "./engine/strategies/direction/clob-momentum.ts",
    "spot-distance": "./engine/strategies/direction/spot-distance.ts",
    "time-weighted": "./engine/strategies/direction/time-weighted.ts",
    "day-hour-edge": "./engine/strategies/direction/day-hour-edge.ts",
    "fak-sniper": "./engine/strategies/execution/fak-sniper.ts",
    "gtc-resting": "./engine/strategies/execution/gtc-resting.ts",
    "synthetic-opposite": "./engine/strategies/execution/synthetic-opposite.ts",
    "chunked-entries": "./engine/strategies/execution/chunked-entries.ts",
    "dynamic-stop": "./engine/strategies/risk/dynamic-stop.ts",
    "timeout-exit": "./engine/strategies/risk/timeout-exit.ts",
  };
  const path = paths[name];
  if (!path) throw new Error(`Unknown strategy: ${name}. Available: ${Object.keys(paths).join(", ")}`);
  const mod = await import(path);
  return mod.default ?? Object.values(mod)[0];
}

// ── Minimal StrategyContext for simulation ─────────────────────────────────────

type StrategyContext = {
  slug: string;
  slotStartMs: number;
  slotEndMs: number;
  clobTokenIds: [string, string];
  orderBook: any;
  log: (msg: string, color?: string) => void;
  postOrders: (orders: any[]) => void;
  cancelOrders: (orderIds: string[]) => Promise<void>;
  emergencySells: (orderIds: string[]) => Promise<void>;
  blockBuys: () => void;
  blockSells: () => void;
  hold: () => () => void;
  pendingOrders: any[];
  orderHistory: any[];
  ticker: { price: number | undefined; divergence: number | null };
  getMarketResult: () => any;
};

// ── Market Fetcher ─────────────────────────────────────────────────────────────

async function fetchActiveMarkets(asset: string, window: string) {
  const tagSlug = `${asset.toLowerCase()}-${window}`;
  const url = `https://gamma-api.polymarket.com/events?tag_slug=${tagSlug}&active=true&closed=false&limit=10`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Gamma API ${resp.status}: ${await resp.text()}`);
  const events = await resp.json() as any[];
  return events.filter(e => e.end_timestamp_iso !== undefined);
}

// ── Order Book ────────────────────────────────────────────────────────────────

class SimpleOrderBook {
  bids: Map<number, number> = new Map(); // price → size
  asks: Map<number, number> = new Map();
  lastUpdate = 0;

  update(bids: [string, string][], asks: [string, string][]) {
    this.bids.clear();
    this.asks.clear();
    for (const [p, s] of bids) {
      const price = parseFloat(p);
      const size = parseFloat(s);
      if (price > 0 && size > 0) this.bids.set(price, size);
    }
    for (const [p, s] of asks) {
      const price = parseFloat(p);
      const size = parseFloat(s);
      if (price > 0 && size > 0) this.asks.set(price, size);
    }
    this.lastUpdate = Date.now();
  }

  bestAskInfo(side: "UP" | "DOWN") {
    const book = side === "UP" ? this.asks : this.bids;
    if (book.size === 0) return null;
    const [price, liquidity] = [...book.entries()].reduce((a, b) => a[0] < b[0] ? a : b);
    return { price, liquidity };
  }

  bestBidInfo(side: "UP" | "DOWN") {
    const book = side === "UP" ? this.bids : this.asks;
    if (book.size === 0) return null;
    const [price, liquidity] = [...book.entries()].reduce((a, b) => a[0] > b[0] ? a : b);
    return { price, liquidity };
  }

  bestBidPrice(side: "UP" | "DOWN") {
    return this.bestBidInfo(side)?.price ?? null;
  }
}

// ── Ticker ─────────────────────────────────────────────────────────────────────

async function fetchTickerPrice(asset: string): Promise<number | null> {
  try {
    const symbol = `${asset.toUpperCase()}USDT`;
    const resp = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`);
    if (!resp.ok) return null;
    const data = await resp.json() as { price: string };
    return parseFloat(data.price);
  } catch { return null; }
}

// ── Simulation State ───────────────────────────────────────────────────────────

type SimState = {
  runId: string;
  createdAt: string;
  completedAt?: string;
  isCompleted: boolean;
  pid: number;
  strategy: string;
  rounds: number;
  currentRound: number;
  sessionPnl: number;
  sessionLoss: number;
  startingBalance: number;
  currentBalance: number;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  trades: any[];
  config: Record<string, string>;
};

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  let strategyName = "";
  let rounds = 20;
  let slotOffset = 1;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--strategy" || args[i] === "-s") strategyName = args[++i];
    else if (args[i] === "--rounds" || args[i] === "-r") rounds = parseInt(args[++i], 10);
    else if (args[i] === "--slot-offset") slotOffset = parseInt(args[++i], 10);
  }

  if (!strategyName) {
    console.error("Usage: bun sim-runner.ts --strategy <name> --rounds <n>");
    process.exit(1);
  }

  const runId = process.env.SIM_RUN_ID ?? Math.random().toString(36).slice(2, 14);
  const stateFile = process.env.SIM_STATE_FILE ?? `state/sim-runs/sim-${runId}.json`;
  mkdirSync(dirname(stateFile) || "state/sim-runs", { recursive: true });

  const startingBalance = parseFloat(process.env.WALLET_BALANCE ?? "50");
  const asset = (process.env.MARKET_ASSET ?? "btc").toLowerCase();
  const window = process.env.MARKET_WINDOW ?? "5m";

  const state: SimState = {
    runId, createdAt: new Date().toISOString(), isCompleted: false, pid: process.pid,
    strategy: strategyName, rounds, currentRound: 0, sessionPnl: 0, sessionLoss: 0,
    startingBalance, currentBalance: startingBalance, totalTrades: 0, winningTrades: 0,
    losingTrades: 0, trades: [], config: {},
  };
  saveState(stateFile, state);

  console.log(`\n[sim-runner] Starting ${strategyName} (${rounds} rounds, asset=${asset})`);
  console.log(`[sim-runner] State: ${stateFile}\n`);

  const Strategy = await loadStrategy(strategyName);

  for (let round = 0; round < rounds; round++) {
    state.currentRound = round;
    saveState(stateFile, state);

    // Fetch active market for this round
    let markets = await fetchActiveMarkets(asset, window);
    if (markets.length === 0) {
      console.log(`[round ${round + 1}] No active markets — waiting 10s...`);
      await sleep(10000);
      markets = await fetchActiveMarkets(asset, window);
      if (markets.length === 0) {
        console.log(`[round ${round + 1}] Still no markets — skipping`);
        continue;
      }
    }

    // Pick market based on slot offset
    const marketIdx = Math.min(slotOffset - 1, markets.length - 1);
    const market = markets[marketIdx];

    const slug = market.condition_id ? `polymarket-${asset}-${window}-${round}` : market.slug ?? `round-${round}`;
    const slotDurationMs = window === "5m" ? 5 * 60 * 1000 : 15 * 60 * 1000;
    const now = Date.now();
    const slotStartMs = now;
    const slotEndMs = now + slotDurationMs;

    // Fetch order book for this market
    const tokenIds = await fetchTokenIds(market);
    const orderBook = new SimpleOrderBook();

    // Fetch initial prices
    await updateOrderBook(orderBook, tokenIds);
    const tickerPrice = await fetchTickerPrice(asset);

    // Build context
    const pendingOrders: any[] = [];
    const orderHistory: any[] = [];
    let buyBlocked = false, sellBlocked = false;
    let holds = 0;

    const ctx: StrategyContext = {
      slug,
      slotStartMs,
      slotEndMs,
      clobTokenIds: tokenIds,
      orderBook,
      log: (msg, color = "cyan") => console.log(`[${strategyName}] ${msg}`),
      postOrders: (orders) => {
        for (const order of orders) {
          const fakeId = `order-${Date.now()}-${Math.random().toString(36).slice(2)}`;
          pendingOrders.push({ orderId: fakeId, ...order.req });
          // Simulate fill after short delay (for simulation)
          setTimeout(() => {
            const idx = pendingOrders.findIndex(o => o.orderId === fakeId);
            if (idx === -1) return;
            const o = pendingOrders[idx];
            pendingOrders.splice(idx, 1);
            orderHistory.push({ action: o.action, price: o.price, shares: o.shares });
            order.onFilled?.(o.shares);
          }, 500 + Math.random() * 2000);
        }
      },
      cancelOrders: async (orderIds) => {
        for (const id of orderIds) {
          const idx = pendingOrders.findIndex(o => o.orderId === id);
          if (idx !== -1) pendingOrders.splice(idx, 1);
        }
      },
      emergencySells: async () => { pendingOrders.length = 0; },
      blockBuys: () => { buyBlocked = true; },
      blockSells: () => { sellBlocked = true; },
      hold: () => { holds++; return () => { holds--; }; },
      pendingOrders,
      orderHistory,
      ticker: { price: tickerPrice ?? undefined, divergence: null },
      getMarketResult: () => ({ openPrice: tickerPrice ?? 50000, slug }),
    };

    console.log(`[round ${round + 1}/${rounds}] Starting market: ${slug} (${((slotEndMs - now)/1000).toFixed(0)}s)`);

    // Run strategy
    const cleanup = await Strategy(ctx);

    // Wait for market to close or strategy to finish
    while (Date.now() < slotEndMs - 1000 && holds > 0) {
      await sleep(1000);
      // Update ticker and order book
      const newPrice = await fetchTickerPrice(asset);
      if (newPrice !== null) ctx.ticker.price = newPrice;
      await updateOrderBook(orderBook, tokenIds);
    }

    // Close any remaining positions at market price
    for (const order of pendingOrders) {
      if (order.action === "buy") {
        const fillPrice = order.price;
        const pnl = (fillPrice - 0.5) * order.shares; // Simplified P&L
        state.sessionPnl += pnl;
        state.currentBalance += pnl;
        state.totalTrades++;
        if (pnl > 0) state.winningTrades++; else state.losingTrades++;
        state.trades.push({
          slug, side: "UP", entryPrice: fillPrice, exitPrice: 0.5,
          shares: order.shares, cost: fillPrice * order.shares, pnl,
          result: pnl > 0 ? "WIN" : "LOSS", closedAt: new Date().toISOString(),
        });
      }
    }
    pendingOrders.length = 0;

    if (cleanup) cleanup();
    saveState(stateFile, state);
    console.log(`[round ${round + 1}] Done. P&L: ${state.sessionPnl >= 0 ? "+" : ""}${state.sessionPnl.toFixed(2)} | Balance: $${state.currentBalance.toFixed(2)}`);

    // Wait between rounds
    if (round < rounds - 1) await sleep(3000);
  }

  state.isCompleted = true;
  state.completedAt = new Date().toISOString();
  saveState(stateFile, state);

  console.log(`\n[sim-runner] ✅ Completed ${rounds} rounds`);
  console.log(`Total P&L: ${state.sessionPnl >= 0 ? "+" : ""}${state.sessionPnl.toFixed(2)}`);
  console.log(`Win rate: ${state.totalTrades > 0 ? (state.winningTrades / state.totalTrades * 100).toFixed(0) : 0}%`);
}

async function updateOrderBook(book: SimpleOrderBook, tokenIds: [string, string]) {
  try {
    const [upId, downId] = tokenIds;
    const [upBook, downBook] = await Promise.all([
      fetch(`https://clob.polymarket.com/books/${upId}`).then(r => r.json()).catch(() => ({ bids: [], asks: [] })),
      fetch(`https://clob.polymarket.com/books/${downId}`).then(r => r.json()).catch(() => ({ bids: [], asks: [] })),
    ]);
    book.update(
      [...(upBook.bids ?? []), ...(downBook.asks ?? [])] as [string, string][],
      [...(upBook.asks ?? []), ...(downBook.bids ?? [])] as [string, string][],
    );
  } catch { /* ignore */ }
}

async function fetchTokenIds(market: any): Promise<[string, string]> {
  try {
    const assets = market.assets ?? [];
    const up = assets.find((a: any) => a.side === "yes" || a.outcome === "yes" || a.description?.toLowerCase().includes("up"));
    const down = assets.find((a: any) => a.side === "no" || a.outcome === "no" || a.description?.toLowerCase().includes("down"));
    return [up?.token_id ?? "", down?.token_id ?? ""];
  } catch {
    return ["", ""];
  }
}

function saveState(path: string, state: SimState) {
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
  require("fs").renameSync(tmp, path);
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

main().catch(err => {
  console.error(`[sim-runner] Fatal: ${err.message}`);
  process.exit(1);
});
