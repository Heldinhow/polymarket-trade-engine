import type { Strategy } from "./types.ts";

const envNum = (k: string, d: number): number => {
  const r = process.env[k];
  if (r === undefined) return d;
  const p = parseFloat(r);
  return Number.isFinite(p) ? p : d;
};

const ENTRY_PRICE = envNum("TWO_SIDED_TP_ENTRY_PRICE", 0.05);
const EXIT_PRICE = envNum("TWO_SIDED_TP_EXIT_PRICE", 0.08);
const SHARES = envNum("TWO_SIDED_TP_SHARES", 10);

export const twoSidedTp: Strategy = async (ctx) => {
  const upTokenId = ctx.clobTokenIds[0];
  const downTokenId = ctx.clobTokenIds[1];
  const timers: ReturnType<typeof setTimeout>[] = [];

  ctx.log(
    `[${ctx.slug}] two-sided-tp: buy UP/DOWN @ ${ENTRY_PRICE.toFixed(2)}, ` +
    `sell @ ${EXIT_PRICE.toFixed(2)}, shares ${SHARES}`,
    "dim",
  );

  ctx.postOrders([
    {
      req: {
        tokenId: upTokenId,
        action: "buy",
        price: ENTRY_PRICE,
        shares: SHARES,
      },
      expireAtMs: ctx.slotEndMs,
      onFilled(filledShares) {
        ctx.log(
          `[${ctx.slug}] two-sided-tp: UP buy filled @ ${ENTRY_PRICE.toFixed(2)} (${filledShares} shares)`,
          "green",
        );
        if (filledShares < 5) {
          ctx.log(
            `[${ctx.slug}] two-sided-tp: UP sell skipped — filled shares (${filledShares}) below minimum of 5`,
            "yellow",
          );
          return;
        }
        ctx.postOrders([
          {
            req: {
              tokenId: upTokenId,
              action: "sell",
              price: EXIT_PRICE,
              shares: filledShares,
            },
            expireAtMs: ctx.slotEndMs,
            onFilled() {
              ctx.log(
                `[${ctx.slug}] two-sided-tp: UP sell @ ${EXIT_PRICE.toFixed(2)} filled`,
                "green",
              );
            },
            onExpired() {
              ctx.log(
                `[${ctx.slug}] two-sided-tp: UP sell @ ${EXIT_PRICE.toFixed(2)} expired`,
                "yellow",
              );
            },
            onFailed(reason) {
              ctx.log(
                `[${ctx.slug}] two-sided-tp: UP sell @ ${EXIT_PRICE.toFixed(2)} failed (${reason})`,
                "red",
              );
            },
          },
        ]);
      },
      onExpired() {
        ctx.log(
          `[${ctx.slug}] two-sided-tp: UP buy @ ${ENTRY_PRICE.toFixed(2)} expired`,
          "yellow",
        );
      },
      onFailed(reason) {
        ctx.log(
          `[${ctx.slug}] two-sided-tp: UP buy @ ${ENTRY_PRICE.toFixed(2)} failed (${reason})`,
          "red",
        );
      },
    },
    {
      req: {
        tokenId: downTokenId,
        action: "buy",
        price: ENTRY_PRICE,
        shares: SHARES,
      },
      expireAtMs: ctx.slotEndMs,
      onFilled(filledShares) {
        ctx.log(
          `[${ctx.slug}] two-sided-tp: DOWN buy filled @ ${ENTRY_PRICE.toFixed(2)} (${filledShares} shares)`,
          "green",
        );
        if (filledShares < 5) {
          ctx.log(
            `[${ctx.slug}] two-sided-tp: DOWN sell skipped — filled shares (${filledShares}) below minimum of 5`,
            "yellow",
          );
          return;
        }
        ctx.postOrders([
          {
            req: {
              tokenId: downTokenId,
              action: "sell",
              price: EXIT_PRICE,
              shares: filledShares,
            },
            expireAtMs: ctx.slotEndMs,
            onFilled() {
              ctx.log(
                `[${ctx.slug}] two-sided-tp: DOWN sell @ ${EXIT_PRICE.toFixed(2)} filled`,
                "green",
              );
            },
            onExpired() {
              ctx.log(
                `[${ctx.slug}] two-sided-tp: DOWN sell @ ${EXIT_PRICE.toFixed(2)} expired`,
                "yellow",
              );
            },
            onFailed(reason) {
              ctx.log(
                `[${ctx.slug}] two-sided-tp: DOWN sell @ ${EXIT_PRICE.toFixed(2)} failed (${reason})`,
                "red",
              );
            },
          },
        ]);
      },
      onExpired() {
        ctx.log(
          `[${ctx.slug}] two-sided-tp: DOWN buy @ ${ENTRY_PRICE.toFixed(2)} expired`,
          "yellow",
        );
      },
      onFailed(reason) {
        ctx.log(
          `[${ctx.slug}] two-sided-tp: DOWN buy @ ${ENTRY_PRICE.toFixed(2)} failed (${reason})`,
          "red",
        );
      },
    },
  ]);

  return () => {
    for (const t of timers) clearTimeout(t);
  };
};
