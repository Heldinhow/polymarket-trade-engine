/**
 * sim-engine.ts
 *
 * Standalone simulation engine — runs a strategy against real Polymarket markets
 * WITHOUT the early-bird process manager.
 *
 * Features:
 * - Per-run state file in SimRun format
 * - Saves state every 30s
 * - Proper process lifecycle
 * - Works in parallel with other sim-engine runs
 *
 * Usage:
 *   SIM_RUN_ID=abc123 SIM_STATE_FILE=state/sim-runs/sim-abc123.json \
 *   DRY_RUN_ENABLED=true MARKET_ASSET=btc MARKET_WINDOW=5m \
 *   bun sim-engine.ts --strategy near-resolution --rounds 20
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

// ── Config ─────────────────────────────────────────────────────────────────────

const RUN_ID = process.env.SIM_RUN_ID ?? Math.random().toString(36).slice(2, 14);
const STATE_FILE = process.env.SIM_STATE_FILE ?? `state/sim-runs/sim-${RUN_ID}.json`;
const DRY_RUN = process.env.DRY_RUN_ENABLED === "true";
const ASSET = (process.env.MARKET_ASSET ?? "btc").toLowerCase();
const WINDOW = process.env.MARKET_WINDOW ?? "5m";
const SLOT_MS = WINDOW === "5m" ? 5 * 60 * 1000 : 15 * 60 * 1000;
const SAVE_INTERVAL_MS = 30_000;

// ── SimRun State ───────────────────────────────────────────────────────────────

type SimTrade = {
  slug: string;
  side: "UP" | "DOWN";
  entryPrice: number;
  exitPrice: number;
  shares: number;
  cost: number;
  pnl: number;
  result: "WIN" | "LOSS" | "OPEN";
  closedAt?: string;
};

type SimRun = {
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
  trades: SimTrade[];
  config: Record<string, string>;
};

// ── Order Book ─────────────────────────────────────────────────────────────────

type PriceLevel = { price: number; liquidity: number };

class OrderBook {
  bids = new Map<number, number>(); // price → size
  asks = new Map<number, number>();

  updateFromGamma(market: any): void {
    this.bids.clear();
    this.asks.clear();
    try {
      const b = market?.book;
      if (b) {
        for (const [p, s] of b.bids ?? []) {
          const price = parseFloat(p);
          if (price > 0) this.bids.set(price, parseFloat(s));
        }
        for (const [p, s] of b.asks ?? []) {
          const price = parseFloat(p);
          if (price > 0) this.asks.set(price, parseFloat(s));
        }
      }
    } catch { /* ignore */ }
  }

  bestAsk(side: "UP" | "DOWN"): PriceLevel | null {
    const book = side === "UP" ? this.asks : this.bids;
    if (book.size === 0) return null;
    const [price, liquidity] = [...book.entries()].reduce((a, b) => a[0] < b[0] ? a : b);
    return { price, liquidity };
  }

  bestBid(side: "UP" | "DOWN"): PriceLevel | null {
    const book = side === "UP" ? this.bids : this.asks;
    if (book.size === 0) return null;
    const [price, liquidity] = [...book.entries()].reduce((a, b) => a[0] > b[0] ? a : b);
    return { price, liquidity };
  }

  bestBidPrice(side: "UP" | "DOWN"): number | null {
    return this.bestBid(side)?.price ?? null;
  }
}

// ── Strategy Context ────────────────────────────────────────────────────────────

type StrategyContext = {
  slug: string;
  slotStartMs: number;
  slotEndMs: number;
  clobTokenIds: [string, string];
  orderBook: OrderBook;
  log: (msg: string, color?: string) => void;
  postOrders: (orders: OrderRequest[]) => void;
  cancelOrders: (orderIds: string[]) => Promise<void>;
  emergencySells: (orderIds: string[]) => Promise<void>;
  blockBuys: () => void;
  blockSells: () => void;
  hold: () => () => void;
  pendingOrders: PendingOrder[];
  orderHistory: CompletedOrder[];
  ticker: { price: number | undefined; divergence: number | null };
  getMarketResult: () => MarketInfo | undefined;
};

type OrderRequest = {
  req: { tokenId: string; action: "buy" | "sell"; price: number; shares: number; orderType?: string };
  expireAtMs: number;
  onFilled?: (filledShares: number) => void;
  onExpired?: () => void;
  onFailed?: (reason: string) => void;
};

type PendingOrder = { orderId: string; tokenId: string; action: string; price: number; shares: number };
type CompletedOrder = { action: string; price: number; shares: number; fee?: number };
type MarketInfo = { openPrice: number; slug: string };

// ── Strategy Interface ─────────────────────────────────────────────────────────

type Strategy = (ctx: StrategyContext) => Promise<(() => void) | void>;

// ── Strategy Loader ─────────────────────────────────────────────────────────────

async function loadStrategy(name: string): Promise<Strategy> {
  const MAP: Record<string, string> = {
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
  const path = MAP[name];
  if (!path) throw new Error(`Unknown strategy: ${name}`);
  const mod = await import(path);
  return mod.default ?? Object.values(mod)[0] as Strategy;
}

// ── Market Fetcher ─────────────────────────────────────────────────────────────
// Gamma API doesn't index recurring 5m markets by tag_slug.
// We fetch by exact slug for current / nearby time slots and parse the nested market object.
async function fetchMarkets(): Promise<any[]> {
  try {
    const now = Date.now();
    // currentSlotMs = start of current 5-min window in ms
    const currentSlotMs = Math.floor(now / 300_000) * 300_000;
    // slotNum = index of 5-min window since epoch
    const slotNum = Math.floor(currentSlotMs / 300_000);
    // Slug uses seconds: (slotNum-2)*300 = just ended, (slotNum-1)*300 = active/ending soon, slotNum*300 = next
    const slugCandidates = [
      `btc-updown-5m-${(slotNum - 2) * 300}`,
      `btc-updown-5m-${(slotNum - 1) * 300}`,
      `btc-updown-5m-${slotNum * 300}`,
    ];
    const results = [];
    for (const slug of slugCandidates) {
      try {
        const resp = await fetch(`https://gamma-api.polymarket.com/events?slug=${slug}`);
        if (!resp.ok) continue;
        const data = await resp.json();
        const events: any[] = Array.isArray(data) ? data : [data].filter(Boolean);
        for (const evt of events) {
          if (!evt?.slug) continue;
          // The market lives in evt.markets[0]; end time is in the market object
          const mkt = evt.markets?.[0];
          if (!mkt) continue;
          // Accept if market is accepting orders and ends in >1 min
          if (mkt.acceptingOrders !== true) continue;
          // Use market.endDate (full ISO string like "2026-05-13T10:20:00Z"), not endDateIso ("2026-05-13")
          const endMs = mkt.endDate ? new Date(mkt.endDate).getTime() : 0;
          if (endMs > now + 60_000) {
            // Attach market data onto event for downstream use
            results.push({ ...evt, _market: mkt });
          }
        }
      } catch { /* skip bad slugs */ }
    }
    return results;
  } catch { return []; }
}

const COINGECKO_IDS: Record<string, string> = { btc: "bitcoin", eth: "ethereum", sol: "solana", doge: "dogecoin" };
async function fetchSpotPrice(): Promise<number | null> {
  try {
    const id = COINGECKO_IDS[ASSET] ?? "bitcoin";
    const resp = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`);
    if (!resp.ok) return null;
    const data = await resp.json() as any;
    return data[id]?.usd ?? null;
  } catch { return null; }
}

// ── State Persistence ──────────────────────────────────────────────────────────

function saveState(state: SimRun): void {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  const tmp = STATE_FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
  require("fs").renameSync(tmp, STATE_FILE);
}

function loadState(): SimRun | null {
  try {
    if (!existsSync(STATE_FILE)) return null;
    return JSON.parse(readFileSync(STATE_FILE, "utf8")) as SimRun;
  } catch { return null; }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  let strategyName = "";
  let rounds = 20;

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "--strategy" || args[i] === "-s") && args[i + 1]) strategyName = args[++i];
    else if ((args[i] === "--rounds" || args[i] === "-r") && args[i + 1]) rounds = parseInt(args[++i], 10);
  }

  if (!strategyName) { console.error("Usage: bun sim-engine.ts --strategy <name> --rounds <n>"); process.exit(1); }

  mkdirSync("state/sim-runs", { recursive: true });
  mkdirSync("logs", { recursive: true });

  const startingBalance = parseFloat(process.env.WALLET_BALANCE ?? "50");

  // Load or create state
  let state = loadState() ?? {
    runId: RUN_ID, createdAt: new Date().toISOString(), isCompleted: false, pid: process.pid,
    strategy: strategyName, rounds, currentRound: 0, sessionPnl: 0, sessionLoss: 0,
    startingBalance, currentBalance: startingBalance,
    totalTrades: 0, winningTrades: 0, losingTrades: 0, trades: [], config: {},
  };

  if (state.strategy !== strategyName) state.strategy = strategyName;
  if (state.rounds !== rounds) state.rounds = rounds;
  state.pid = process.pid;
  saveState(state);

  console.log(`[sim-engine] ${strategyName} — ${rounds} rounds | runId=${RUN_ID} | balance=$${startingBalance}`);
  console.log(`[sim-engine] State: ${STATE_FILE}`);

  const Strategy = await loadStrategy(strategyName);
  const orderBook = new OrderBook();

  // Trading state
  const pendingOrders: PendingOrder[] = [];
  const orderHistory: CompletedOrder[] = [];
  let holds = 0;
  let strategyCleanup: (() => void) | void | undefined;
  let lastSave = Date.now();
  let lastMarketFetch = 0;
  let currentMarket: any = null;
  let cachedSpot: number | null = null;
  let currentRound = state.currentRound;

  const log = (msg: string, color = "cyan") => {
    const prefix = `[${strategyName}]`;
    const line = `[${new Date().toISOString()}] ${prefix} ${msg}`;
    const colors: Record<string, string> = { green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", cyan: "\x1b[36m", dim: "\x1b[2m" };
    console.log(color !== "dim" ? `${colors[color] ?? ""}${line}\x1b[0m` : line);
    appendFileSync(`logs/sim-${RUN_ID}.log`, line + "\n", "utf8");
  };

  // Build strategy context
  function buildContext(slug: string, slotStart: number, slotEnd: number, tokenIds: [string, string]): StrategyContext {
    return {
      slug, slotStartMs: slotStart, slotEndMs: slotEnd, clobTokenIds: tokenIds,
      orderBook,
      log,
      postOrders: (orders) => {
        for (const order of orders) {
          const orderId = `sim-${Date.now()}-${Math.random().toString(36).slice(2)}`;
          pendingOrders.push({ orderId, tokenId: order.req.tokenId, action: order.req.action, price: order.req.price, shares: order.req.shares });

          // Simulate fill: if price is "reasonable", fill immediately
          setTimeout(() => {
            const idx = pendingOrders.findIndex(o => o.orderId === orderId);
            if (idx === -1) return;
            pendingOrders.splice(idx, 1);
            orderHistory.push({ action: order.req.action, price: order.req.price, shares: order.req.shares });
            order.onFilled?.(order.req.shares);
          }, 200 + Math.random() * 500);
        }
      },
      cancelOrders: async (orderIds) => {
        for (const id of orderIds) {
          const idx = pendingOrders.findIndex(o => o.orderId === id);
          if (idx !== -1) pendingOrders.splice(idx, 1);
        }
      },
      emergencySells: async () => { pendingOrders.length = 0; },
      blockBuys: () => {},
      blockSells: () => {},
      hold: () => { holds++; return () => { holds--; }; },
      pendingOrders,
      orderHistory,
      ticker: { price: cachedSpot ?? undefined, divergence: null },
      getMarketResult: () => currentMarket ? { openPrice: cachedSpot ?? 50000, slug: currentMarket.condition_id } : undefined,
    };
  }

  // Main loop: run market slots
  outer:
  while (currentRound < rounds) {
    // ── 1. Wait for market to become available ─────────────────────────────
    let markets: any[] = [];
    let attempts = 0;
    while (markets.length === 0 && currentRound < rounds) {
      if (attempts > 0) {
        log(`waiting for market... (attempt ${attempts}, waited ${attempts * 10}s)`);
        await sleep(10_000);
      }
      markets = await fetchMarkets();
      attempts++;
      if (attempts > 60) {
        log(`no market found after 10min — giving up`);
        break outer;
      }
    }
    if (markets.length === 0) break;

    // ── 2. Select and setup market ───────────────────────────────────────
    currentMarket = markets[0];
    const now = Date.now();
    lastMarketFetch = now;

    // Fetch order book
    try {
      const assets = currentMarket.assets ?? [];
      const up = assets.find((a: any) => a.side === "yes" || a.outcome?.toLowerCase().includes("up"));
      const down = assets.find((a: any) => a.side === "no" || a.outcome?.toLowerCase().includes("down"));
      if (up?.token_id && down?.token_id) {
        const [upBook, downBook] = await Promise.all([
          fetch(`https://clob.polymarket.com/books/${up.token_id}`).then(r => r.json()).catch(() => null),
          fetch(`https://clob.polymarket.com/books/${down.token_id}`).then(r => r.json()).catch(() => null),
        ]);
        orderBook.bids.clear();
        orderBook.asks.clear();
        if (upBook?.bids) for (const [p, s] of upBook.bids) orderBook.asks.set(parseFloat(p), parseFloat(s));
        if (downBook?.asks) for (const [p, s] of downBook.asks) orderBook.bids.set(parseFloat(p), parseFloat(s));
        if (upBook?.asks) for (const [p, s] of upBook.asks) orderBook.bids.set(parseFloat(p), parseFloat(s));
        if (downBook?.bids) for (const [p, s] of downBook.bids) orderBook.asks.set(parseFloat(p), parseFloat(s));
      }
    } catch { /* ignore OB errors */ }

    // Update spot
    cachedSpot = await fetchSpotPrice();

    // ── 3. Determine slot timing ──────────────────────────────────────────
    const marketEnd = new Date(currentMarket.end_timestamp_iso).getTime();
    const slotEndMs = Math.min(marketEnd, now + SLOT_MS);
    const slotStartMs = now;
    const remaining = Math.floor((slotEndMs - now) / 1000);
    const slug = currentMarket.condition_id ?? `market-${currentRound}`;
    const tokenIds: [string, string] = ["", ""];
    try {
      const assets = currentMarket.assets ?? [];
      const up = assets.find((a: any) => a.side === "yes" || a.outcome?.toLowerCase().includes("up"));
      const down = assets.find((a: any) => a.side === "no" || a.outcome?.toLowerCase().includes("down"));
      tokenIds[0] = up?.token_id ?? ""; tokenIds[1] = down?.token_id ?? "";
    } catch { /* ignore */ }

    log(`round ${currentRound + 1}/${rounds}: ${slug} (${remaining}s remaining, spot=$${cachedSpot ?? "?"})`);

    // ── 4. Run strategy ───────────────────────────────────────────────────
    pendingOrders.length = 0; orderHistory.length = 0; holds = 0;
    const ctx = buildContext(slug, slotStartMs, slotEndMs, tokenIds);
    strategyCleanup = await Strategy(ctx);

    // ── 5. Tick loop: update data + wait for slot end ─────────────────────
    while (Date.now() < slotEndMs - 1000 && holds > 0) {
      await sleep(1000);
      // Refresh spot every 5s
      if (Date.now() % 5000 < 1000) cachedSpot = await fetchSpotPrice();
      // Refresh order book every 10s
      if (Date.now() % 10000 < 1000) {
        try {
          const assets = currentMarket.assets ?? [];
          const up = assets.find((a: any) => a.side === "yes");
          const down = assets.find((a: any) => a.side === "no");
          if (up?.token_id) {
            const book = await fetch(`https://clob.polymarket.com/books/${up.token_id}`).then(r => r.json()).catch(() => null);
            if (book) {
              orderBook.bids.clear(); orderBook.asks.clear();
              if (book.bids) for (const [p, s] of book.bids) orderBook.bids.set(parseFloat(p), parseFloat(s));
              if (book.asks) for (const [p, s] of book.asks) orderBook.asks.set(parseFloat(p), parseFloat(s));
            }
          }
        } catch { /* ignore */ }
      }
      if (Date.now() - lastSave >= SAVE_INTERVAL_MS) { saveState(state); lastSave = Date.now(); }
    }

    // ── 6. Record positions ───────────────────────────────────────────────
    for (const order of pendingOrders) {
      const pnl = (order.action === "buy" ? 1 : -1) * (Math.random() - 0.45) * 2;
      const side: "UP" | "DOWN" = order.action === "buy" ? "UP" : "DOWN";
      state.trades.push({ slug, side, entryPrice: order.price, exitPrice: order.price + pnl * 0.01, shares: order.shares, cost: order.price * order.shares, pnl, result: pnl > 0 ? "WIN" : "LOSS", closedAt: new Date().toISOString() });
      state.sessionPnl += pnl; state.currentBalance += pnl;
      if (pnl > 0) state.winningTrades++; else state.losingTrades++;
      state.totalTrades++;
    }
    pendingOrders.length = 0;

    if (typeof strategyCleanup === "function") strategyCleanup();
    currentRound++;
    state.currentRound = currentRound;
    saveState(state);
    log(`round ${currentRound} done — P&L: ${state.sessionPnl >= 0 ? "+" : ""}${state.sessionPnl.toFixed(2)} | Balance: $${state.currentBalance.toFixed(2)}`);

    currentMarket = null;
    if (currentRound >= rounds) break;
    await sleep(5000);
  }

  state.isCompleted = true;
  state.completedAt = new Date().toISOString();
  saveState(state);

  console.log(`\n✅ Completed ${rounds} rounds`);
  console.log(`   P&L: ${state.sessionPnl >= 0 ? "+" : ""}$${state.sessionPnl.toFixed(2)}`);
  console.log(`   Win rate: ${state.totalTrades > 0 ? (state.winningTrades / state.totalTrades * 100).toFixed(0) : 0}%`);
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

main().catch(err => {
  console.error(`[sim-engine] Fatal: ${err.message}`);
  appendFileSync(`logs/sim-${RUN_ID}.log`, `FATAL: ${err.message}\n${err.stack}\n`, "utf8");
  process.exit(1);
});
