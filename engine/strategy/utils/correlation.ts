import { fetchWithRetry } from "../../../utils/fetch-retry.ts";

const GAMMA_API = "https://gamma-api.polymarket.com";

export type BTCProbs = {
  btcUpProb: number;
  btcDownProb: number;
};

export type SyncData = {
  syncRate: number;
  concordant: number;
  divergent: number;
  btcSequence: string[];
  targetSequence: string[];
};

type CorrelationWindow = "5m" | "15m";

const WINDOW_SECONDS: Record<CorrelationWindow, number> = {
  "5m": 300,
  "15m": 900,
};

export function assetFromSlug(slug: string): string {
  return slug.split("-")[0]!;
}

export function slugForAsset(
  asset: string,
  endTimestamp: number,
  window: CorrelationWindow = "5m",
): string {
  return `${asset}-updown-${window}-${endTimestamp}`;
}

export async function fetchBTCProbabilities(
  slotEndSeconds: number,
  window: CorrelationWindow = "5m",
): Promise<BTCProbs | null> {
  const slug = slugForAsset("btc", slotEndSeconds, window);
  try {
    const res = await fetchWithRetry(`${GAMMA_API}/events?slug=${slug}`, {
      totalRetry: 2,
    });
    const events = (await res.json()) as any[];
    const market = events?.[0]?.markets?.[0];
    if (!market) return null;
    const prices = parsePrices(market.outcomePrices);
    if (!prices) return null;
    return { btcUpProb: prices[0], btcDownProb: prices[1] };
  } catch {
    return null;
  }
}

export async function marketOutcome(
  slug: string,
): Promise<"UP" | "DOWN" | null> {
  try {
    const res = await fetchWithRetry(`${GAMMA_API}/events?slug=${slug}`, {
      totalRetry: 2,
    });
    const events = (await res.json()) as any[];
    const market = events?.[0]?.markets?.[0];
    if (!market) return null;
    const prices = parsePrices(market.outcomePrices);
    if (!prices) return null;
    if (prices[0] >= 0.95) return "UP";
    if (prices[1] >= 0.95) return "DOWN";
    return null;
  } catch {
    return null;
  }
}

export async function computeSyncRate(
  targetAsset: string,
  lookbackWindows = 10,
  window: CorrelationWindow = "5m",
): Promise<SyncData | null> {
  const now = Math.floor(Date.now() / 1000);
  const interval = WINDOW_SECONDS[window];
  const currentBoundary = Math.floor(now / interval) * interval;

  const btcSequence: string[] = [];
  const targetSequence: string[] = [];
  let concordant = 0;
  let divergent = 0;

  for (let i = 1; i <= lookbackWindows; i++) {
    const ts = currentBoundary - i * interval;
    const [btcOutcome, targetOutcome] = await Promise.all([
      marketOutcome(slugForAsset("btc", ts, window)),
      marketOutcome(slugForAsset(targetAsset, ts, window)),
    ]);

    if (btcOutcome && targetOutcome) {
      btcSequence.push(btcOutcome);
      targetSequence.push(targetOutcome);
      if (btcOutcome === targetOutcome) concordant++;
      else divergent++;
    }
  }

  const total = concordant + divergent;
  if (total === 0) return null;

  return {
    syncRate: concordant / total,
    concordant,
    divergent,
    btcSequence,
    targetSequence,
  };
}

function parsePrices(raw: string): [number, number] | null {
  try {
    const arr = typeof raw === "string" ? JSON.parse(raw) : raw;
    const up = parseFloat(arr[0]);
    const down = parseFloat(arr[1]);
    if (isNaN(up) || isNaN(down)) return null;
    return [up, down];
  } catch {
    return null;
  }
}
