// Backtests the trading styles on candle files.
//
//   pnpm backtest -- <file-or-folder>... [--strategy trend,reversion,flow,accumulate]
//                    [--profile balanced] [--fee 30] [--slip 40] [--set key=value,...] [--json]
//
// Files hold one candle per line: time, open, high, low, close, volume (commas
// or semicolons). Folders are searched for .csv and .txt files. Get candles for
// a Solana pool with scripts/fetch-ohlcv.ts.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import { backtest, parseCandles, type BacktestResult } from "../src/backtest";
import { parseStrategy, STRATEGY_IDS, type RiskProfile, type StrategyId } from "../src/strategies";

const args = process.argv.slice(2).filter((a) => a !== "--");
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const valueFlags = new Set(["strategy", "profile", "fee", "slip", "set", "min-candles"]);
const paths = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1]!.startsWith("--") && valueFlags.has(args[i - 1]!.slice(2))));

function files(p: string): string[] {
  if (!statSync(p).isDirectory()) return [p];
  return readdirSync(p).flatMap((f) => {
    const full = join(p, f);
    return statSync(full).isDirectory() ? files(full) : /\.(csv|txt)$/i.test(f) ? [full] : [];
  });
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2) : 0;
};
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

async function main() {
  if (!paths.length) throw new Error("give at least one candle file or folder");
  const ids = (flag("strategy")?.split(",") ?? STRATEGY_IDS) as StrategyId[];
  const profile = (flag("profile") ?? "balanced") as RiskProfile;
  const feeBps = Number(flag("fee") ?? 100);
  const slippageBps = Number(flag("slip") ?? 300);
  const minCandles = Number(flag("min-candles") ?? 2_000);
  const set = Object.fromEntries((flag("set")?.split(",") ?? []).map((kv) => kv.split("=")).map(([k, v]) => [k!, Number(v)]));
  const all = paths.flatMap(files);
  const json = args.includes("--json");
  for (const id of ids) {
    // Tell the strategy the cost it will really pay, unless the caller set one.
    const params = { costBps: 2 * feeBps + slippageBps, ...set };
    const known = parseStrategy(id, "strategy", { id, profile }).params;
    const strategy = parseStrategy({ id, profile, params: Object.fromEntries(Object.entries(params).filter(([k]) => k in known)) }, "--set", { id, profile });
    const rows: (BacktestResult & { file: string })[] = [];
    for (const f of all) {
      const candles = parseCandles(readFileSync(f, "utf8"));
      if (candles.length < minCandles) continue;
      rows.push({ file: basename(f), ...(await backtest(candles, { strategy, feeBps, slippageBps, ...(id === "flow" ? { flowProxy: { volX: 3, bars: 20 } } : {}) })) });
    }
    const r = (k: keyof BacktestResult) => rows.map((x) => x[k]);
    const summary = {
      strategy: id,
      profile,
      feeBps,
      slippageBps,
      coins: rows.length,
      meanReturnPct: +mean(r("returnPct")).toFixed(2),
      medianReturnPct: +median(r("returnPct")).toFixed(2),
      meanBuyHoldPct: +mean(r("buyHoldPct")).toFixed(2),
      medianBuyHoldPct: +median(r("buyHoldPct")).toFixed(2),
      beatBuyHoldPct: +((rows.filter((x) => x.returnPct > x.buyHoldPct).length / Math.max(1, rows.length)) * 100).toFixed(1),
      profitableCoinsPct: +((rows.filter((x) => x.returnPct > 0).length / Math.max(1, rows.length)) * 100).toFixed(1),
      meanMaxDrawdownPct: +mean(r("maxDrawdownPct")).toFixed(2),
      worstReturnPct: +Math.min(...r("returnPct")).toFixed(2),
      sells: rows.reduce((a, x) => a + x.sells, 0),
      winRatePct: +((rows.reduce((a, x) => a + (x.winRatePct * x.sells) / 100, 0) / Math.max(1, rows.reduce((a, x) => a + x.sells, 0))) * 100).toFixed(1),
      meanExposurePct: +mean(r("exposurePct")).toFixed(1),
    };
    if (json) console.log(JSON.stringify({ ...summary, rows }));
    else {
      if (rows.length <= 12) for (const x of rows) console.log(`  ${x.file.padEnd(40)} ${x.returnPct.toFixed(2).padStart(8)}%  hold ${x.buyHoldPct.toFixed(2).padStart(8)}%  dd ${x.maxDrawdownPct.toFixed(1).padStart(5)}%  sells ${String(x.sells).padStart(4)}  win ${x.winRatePct.toFixed(0)}%`);
      console.log(summary);
    }
  }
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
