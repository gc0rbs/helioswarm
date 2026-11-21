// Saves a Solana token's candles (GeckoTerminal, USD) as a file scripts/backtest.ts reads.
//
//   pnpm fetch-ohlcv -- <mint> [--sec 60] [--pages 10] [--out candles.csv]
//
// Each page is up to 1000 candles; the free API allows about 30 calls a minute.
import { writeFileSync } from "node:fs";

import type { Candle } from "../src/backtest";
import { poolCandles, topPool } from "../src/history";

const args = process.argv.slice(2).filter((a) => a !== "--");
const flag = (n: string) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : undefined);

async function main() {
  const mint = args[0];
  if (!mint || mint.startsWith("--")) throw new Error("give a token mint");
  const sec = Number(flag("sec") ?? 60);
  const pages = Number(flag("pages") ?? 10);
  const out = flag("out") ?? `${mint.slice(0, 6)}-${sec}s.csv`;
  const pool = await topPool(mint);
  let all: Candle[] = [];
  let before: number | undefined;
  for (let i = 0; i < pages; i++) {
    const page = await poolCandles(pool, { sec, before });
    if (!page.length) break;
    all = [...page, ...all];
    before = page[0]!.t;
    await new Promise((r) => setTimeout(r, 2_500));
  }
  writeFileSync(out, all.map((c) => [Math.floor(c.t / 1000), c.o, c.h, c.l, c.c, c.v].join(",")).join("\n") + "\n");
  console.log(`${all.length} candles of ${sec}s from pool ${pool} saved to ${out}`);
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
