type Side = "UP" | "DOWN";

export type DashboardSignal = {
  baseAsset: string;
  targetAsset: string;
  side: Side;
  basePrice: number;
  targetPrice: number;
  difference: number;
};

export type DashboardSync = {
  syncRate: number;
  concordant: number;
  divergent: number;
};

export type DashboardPosition = {
  side: Side;
  shares: number;
  entryPrice: number;
};

export type StrategyTelemetry = {
  signal?: DashboardSignal | null;
  sync?: DashboardSync | null;
  position?: DashboardPosition | null;
};

export type LifecycleDashboardSnapshot = {
  slug: string;
  state: string;
  remainingSecs: number;
  pendingBuyCount: number;
  pendingSellCount: number;
  position?: DashboardPosition | null;
  telemetry?: StrategyTelemetry;
};

export type EngineDashboardSnapshot = {
  strategyName: string;
  prod: boolean;
  assetSymbol: string;
  marketWindow: string;
  sessionPnl: number;
  bankroll: { balance: number; available: number } | null;
  lifecycles: LifecycleDashboardSnapshot[];
};

const HEADER = [
  " ____   ___  _ __   _______ _____ ____  __  __ ",
  "|  _ \\ / _ \\| | \\ / /_   _| ____|  _ \\|  \\/  |",
  "| |_) | | | | |  \\ V /  | | |  _| | |_) | |\\/| |",
  "|  __/| |_| | |___| |   | | | |___|  _ <| |  | |",
  "|_|    \\___/|_____|_|   |_| |_____|_| \\_\\_|  |_|",
  "Terminal-Based Monitoring for PolyMarket",
  "",
];

export function buildDashboardLines(snapshot: EngineDashboardSnapshot): string[] {
  const lifecycle = snapshot.lifecycles[0] ?? null;
  const telemetry = lifecycle?.telemetry;
  const position = telemetry?.position ?? lifecycle?.position ?? null;

  return [
    ...HEADER,
    row("Strategy", snapshot.strategyName),
    row("Mode", snapshot.prod ? "PROD" : "SIM"),
    row(
      "Market",
      `${snapshot.assetSymbol} ${snapshot.marketWindow} | ${lifecycle?.slug ?? "waiting"}`,
    ),
    row(
      "State",
      lifecycle
        ? `${lifecycle.state} | remaining ${formatDuration(lifecycle.remainingSecs)}`
        : "waiting",
    ),
    "",
    row("Signal", formatSignal(telemetry?.signal ?? null)),
    row("Sync", formatSync(telemetry?.sync ?? null)),
    row("Bankroll", formatBankroll(snapshot.bankroll)),
    row("Session P&L", formatMoney(snapshot.sessionPnl, true)),
    row("Orders", formatOrders(lifecycle)),
    row("Position", formatPosition(position)),
  ];
}

function row(label: string, value: string): string {
  return `${label.padEnd(14)}${value}`;
}

function formatSignal(signal: DashboardSignal | null): string {
  if (!signal) return "--";
  return `${signal.baseAsset} ${signal.side} ${signal.basePrice.toFixed(2)} / ${signal.targetAsset} ${signal.side} ${signal.targetPrice.toFixed(2)} => ${formatCents(signal.difference)}`;
}

function formatSync(sync: DashboardSync | null): string {
  if (!sync) return "--";
  return `${Math.round(sync.syncRate * 100)}% (${sync.concordant} concordant / ${sync.divergent} divergent)`;
}

function formatBankroll(bankroll: EngineDashboardSnapshot["bankroll"]): string {
  if (!bankroll) return "--";
  return `${formatMoney(bankroll.balance)} total | ${formatMoney(bankroll.available)} available`;
}

function formatOrders(lifecycle: LifecycleDashboardSnapshot | null): string {
  if (!lifecycle) return "--";
  return `${lifecycle.pendingBuyCount} buy pending | ${lifecycle.pendingSellCount} sell pending`;
}

function formatPosition(position: DashboardPosition | null): string {
  if (!position) return "--";
  return `${position.side} ${formatShares(position.shares)} shares @ ${position.entryPrice.toFixed(2)}`;
}

function formatDuration(seconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  const mins = Math.floor(safeSeconds / 60);
  const secs = safeSeconds % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function formatMoney(value: number, includeSign = false): string {
  const sign = includeSign ? (value >= 0 ? "+" : "-") : value < 0 ? "-" : "";
  return `${sign}$${Math.abs(value).toFixed(2)}`;
}

function formatCents(value: number): string {
  const cents = Math.round(value * 100);
  const sign = cents >= 0 ? "+" : "";
  return `${sign}${cents}c`;
}

function formatShares(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(4);
}
