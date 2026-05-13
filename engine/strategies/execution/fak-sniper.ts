/**
 * 9. FAK Sniper — Fill And Kill
 *
 * Tenta pegar liquidez instantânea.
 * Se não preencher, cancela.
 * Boa para velocidade / scalp.
 */
import type { Strategy, StrategyContext } from "../types.ts";
import { Env } from "../../utils/config.ts";

type FakSniperConfig = {
  enabled: boolean;
  maxRetries: number;           // number of FAK attempts per slot
  retryDelayMs: number;          // delay between retries
  acceptableSlippage: number;    // max slippage from mid price
  orderType: "FOK" | "IOC";
};

function loadConfig(): FakSniperConfig {
  return {
    enabled: Env.get("ENABLE_FAK_SNIPER") !== "false",
    maxRetries: parseInt(Env.get("FAK_SNIPER_MAX_RETRIES") ?? "3", 10),
    retryDelayMs: parseInt(Env.get("FAK_SNIPER_RETRY_DELAY_MS") ?? "200", 10),
    acceptableSlippage: parseFloat(Env.get("FAK_SNIPER_SLIPPAGE") ?? "0.02"),
    orderType: (Env.get("FAK_SNIPER_ORDER_TYPE") as "FOK" | "IOC") ?? "FOK",
  };
}

type State = {
  entered: boolean;
  enteredSide: "UP" | "DOWN" | null;
  enteredAtPrice: number;
  shares: number;
  retriesLeft: number;
};

const DEFAULT_SHARES = 6;

export const fakSniper: Strategy = async (ctx) => {
  if (!Env.get("DRY_RUN_ENABLED")) { ctx.log("[fak-sniper] DRY_RUN_REQUIRED", "red"); process.exit(1); }
  const cfg = loadConfig();
  if (!cfg.enabled) { ctx.log("[fak-sniper] disabled", "dim"); return; }

  const release = ctx.hold();
  const state: State = { entered: false, enteredSide: null, enteredAtPrice: 0, shares: 0, retriesLeft: cfg.maxRetries };

  const log = (msg: string, color: "cyan" | "green" | "yellow" | "red" | "dim" = "cyan") =>
    ctx.log(`[fak-sniper] ${msg}`, color);

  const tryFak = (side: "UP" | "DOWN", price: number, attempt: number) => {
    const tokenId = side === "UP" ? ctx.clobTokenIds[0] : ctx.clobTokenIds[1];
    const orderType = cfg.orderType;

    ctx.postOrders([{
      req: { tokenId, action: "buy", price, shares: DEFAULT_SHARES, orderType: orderType as "GTC" | "FOK" },
      expireAtMs: ctx.slotEndMs,
      onFilled(filledShares) {
        log(`FAK ${side} filled @ ${price} (attempt ${attempt}, ${filledShares} shares)`, "green");
        state.entered = true; state.enteredSide = side; state.enteredAtPrice = price; state.shares = filledShares;
        release(); // entry done, release hold
      },
      onExpired() {
        log(`FAK ${side} not filled (attempt ${attempt}/${cfg.maxRetries})`, attempt < cfg.maxRetries ? "yellow" : "red");
        if (attempt < cfg.maxRetries) {
          setTimeout(() => tryFak(side, price, attempt + 1), cfg.retryDelayMs);
        } else {
          log("FAK: all retries exhausted — giving up", "red");
          release();
        }
      },
      onFailed(reason) {
        log(`FAK ${side} failed: ${reason} (attempt ${attempt})`, "red");
        if (attempt < cfg.maxRetries) {
          setTimeout(() => tryFak(side, price, attempt + 1), cfg.retryDelayMs);
        } else {
          release();
        }
      },
    }]);
  };

  const interval = setInterval(() => {
    const remaining = Math.floor((ctx.slotEndMs - Date.now()) / 1000);
    if (remaining <= 0) { clearInterval(interval); release(); return; }
    if (state.entered) { clearInterval(interval); release(); return; }
    if (state.retriesLeft <= 0) { clearInterval(interval); release(); return; }

    // Entry: try to enter near mid-price
    const upAsk = ctx.orderBook.bestAskInfo("UP");
    const downAsk = ctx.orderBook.bestAskInfo("DOWN");
    if (!upAsk || !downAsk) return;

    const upMid = upAsk.price; // best ask = near-mid
    const downMid = downAsk.price;

    // Try UP if it looks cheap (below mid - slippage)
    if (upMid <= 0.5 - cfg.acceptableSlippage) {
      state.retriesLeft--;
      log(`sniping UP @ ${upMid.toFixed(4)}`, "cyan");
      tryFak("UP", upMid, 1);
      clearInterval(interval);
    } else if (downMid <= 0.5 - cfg.acceptableSlippage) {
      state.retriesLeft--;
      log(`sniping DOWN @ ${downMid.toFixed(4)}`, "cyan");
      tryFak("DOWN", downMid, 1);
      clearInterval(interval);
    }
  }, 100);

  return () => clearInterval(interval);
};

export default fakSniper;