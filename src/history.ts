// Past candles for a Solana token, from GeckoTerminal's public API (no key).
// Used to warm a strategy's bars up at startup, so an agent on 4-hour bars does
// not sit idle for days, and by scripts/fetch-ohlcv.ts to save candles for backtests.
import type { Candle } from "./backtest";

const BASE = "https://api.geckoterminal.com/api/v2";

/** Candle sizes the API serves, largest first. */
const SIZES: { timeframe: "day" | "hour" | "minute"; aggregate: number; sec: number }[] = [
  { timeframe: "day", aggregate: 1, sec: 86_400 },
  { timeframe: "hour", aggregate: 12, sec: 43_200 },
  { timeframe: "hour", aggregate: 4, sec: 14_400 },
  { timeframe: "hour", aggregate: 1, sec: 3_600 },
  { timeframe: "minute", aggregate: 15, sec: 900 },
  { timeframe: "minute", aggregate: 5, sec: 300 },
  { timeframe: "minute", aggregate: 1, sec: 60 },
];

/** The largest served candle that fits evenly into a bar of barSec. */
export const candleSizeFor = (barSec: number) => SIZES.find((s) => s.sec <= barSec && barSec % s.sec === 0) ?? SIZES[SIZES.length - 1]!;

async function get(url: string, fetcher: typeof fetch): Promise<any> {
  const res = await fetcher(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`geckoterminal ${res.status}`);
  return res.json();
}

/** The token's most liquid pool, as GeckoTerminal ranks them. */
export async function topPool(mint: string, fetcher: typeof fetch = fetch, base = BASE): Promise<string> {
  const body = await get(`${base}/networks/solana/tokens/${mint}/pools?page=1`, fetcher);
  const pool = body?.data?.[0]?.attributes?.address;
  if (typeof pool !== "string") throw new Error(`no pool found for ${mint}`);
  return pool;
}

/** Up to `limit` (max 1000) candles of a pool, oldest first, priced in USD. */
export async function poolCandles(pool: string, o: { sec: number; limit?: number; before?: number; fetcher?: typeof fetch; base?: string }): Promise<Candle[]> {
  const size = SIZES.find((s) => s.sec === o.sec);
  if (!size) throw new Error(`candle size must be one of ${SIZES.map((s) => s.sec).join(", ")} seconds`);
  const q = new URLSearchParams({ aggregate: String(size.aggregate), limit: String(Math.min(1000, o.limit ?? 1000)), currency: "usd" });
  if (o.before) q.set("before_timestamp", String(Math.floor(o.before / 1000)));
  const body = await get(`${o.base ?? BASE}/networks/solana/pools/${pool}/ohlcv/${size.timeframe}?${q}`, o.fetcher ?? fetch);
  const list = body?.data?.attributes?.ohlcv_list;
  if (!Array.isArray(list)) throw new Error("unexpected ohlcv response");
  return list
    .map((r: number[]) => ({ t: r[0]! * 1000, o: +r[1]!, h: +r[2]!, l: +r[3]!, c: +r[4]!, v: +(r[5] ?? 0) }))
    .filter((c: Candle) => c.o > 0 && c.h > 0 && c.l > 0 && c.c > 0)
    .sort((a: Candle, b: Candle) => a.t - b.t);
}

/** Enough recent candles of a token to fill `bars` bars of barSec. */
export async function warmupCandles(mint: string, barSec: number, bars: number, fetcher: typeof fetch = fetch): Promise<Candle[]> {
  const size = candleSizeFor(barSec);
  const pool = await topPool(mint, fetcher);
  return poolCandles(pool, { sec: size.sec, limit: Math.min(1000, Math.ceil((bars * barSec) / size.sec) + 2), fetcher });
}
