/**
 * state-adapter.ts — polls early-bird state files and converts to SimRun
 */
import { existsSync, readFileSync, writeFileSync, readdirSync } from "fs";
import { join } from "path";

const SIM_STATE_DIR = "state/sim-runs";

type EbState = {
  sessionPnl?: number; sessionLoss?: number;
  activeMarkets?: any[]; completedMarkets?: any[];
};
type SimTrade = { slug: string; side: "UP"|"DOWN"; entryPrice: number; exitPrice: number; shares: number; cost: number; pnl: number; result: "WIN"|"LOSS"|"OPEN"; closedAt?: string };
type SimRun = {
  runId: string; createdAt: string; completedAt?: string; isCompleted: boolean; pid?: number | null;
  strategy: string; rounds: number; currentRound: number;
  sessionPnl: number; sessionLoss: number; startingBalance: number; currentBalance: number;
  totalTrades: number; winningTrades: number; losingTrades: number; trades: SimTrade[]; config: Record<string,string>;
};

function map(eb: EbState, sim: SimRun): SimRun {
  const completed = eb.completedMarkets ?? [];
  const trades: SimTrade[] = [];
  let wt=0, lt=0;
  for (const m of completed) {
    for (const o of m.orderHistory ?? []) {
      if (o.action==="buy") {
        const pnl = m.pnl??0;
        const r: "WIN"|"LOSS" = pnl>0?"WIN":"LOSS";
        if(r==="WIN") wt++; else lt++;
        trades.push({ slug:m.slug, side:"UP", entryPrice:o.price, exitPrice:o.price+(pnl/o.shares), shares:o.shares, cost:o.price*o.shares, pnl, result:r, closedAt:new Date().toISOString() });
      }
    }
  }
  const sp = eb.sessionPnl??sim.sessionPnl;
  const sl = eb.sessionLoss??sim.sessionLoss;
  return { ...sim, sessionPnl:sp, sessionLoss:sl, currentBalance:sim.startingBalance+sp, totalTrades:sim.totalTrades+wt+lt, winningTrades:sim.winningTrades+wt, losingTrades:sim.losingTrades+lt, trades:[...sim.trades,...trades].slice(-100), currentRound:completed.length, isCompleted: completed.length>=sim.rounds, completedAt: completed.length>=sim.rounds ? new Date().toISOString():undefined };
}

function poll() {
  if (!existsSync(SIM_STATE_DIR)) return;
  const files = readdirSync(SIM_STATE_DIR).filter(f=>f.startsWith("sim-")&&f.endsWith(".json"));
  for (const file of files) {
    const path = join(SIM_STATE_DIR, file);
    let sim: SimRun; try { sim = JSON.parse(readFileSync(path,"utf8")); } catch { continue; }
    if (sim.isCompleted) continue;
    if (sim.pid) { try { process.kill(sim.pid, 0); } catch { sim.isCompleted=true; sim.completedAt=new Date().toISOString(); writeFileSync(path, JSON.stringify(sim,null,2)); continue; } }
    let eb: EbState; try { eb = JSON.parse(readFileSync(path,"utf8")); if(eb.sessionPnl===undefined) continue; } catch { continue; }
    const next = map(eb, sim);
    if (JSON.stringify(next)!==JSON.stringify(sim)) writeFileSync(path, JSON.stringify(next,null,2));
  }
}

setInterval(poll, 5000);
poll();
console.log("[adapter] Running — polls every 5s");
