// Replays real candles through a strategy, with the same swarm, guard rails and
// paper fills a paper run uses. One agent, one coin, long only. Results are a
// check on a strategy's settings, not a promise: see docs/strategies.md.
import { parseConfig } from "./config";
import type { PriceFeed, Quote } from "./feeds";
import { expandGroups } from "./roster";
import type { StrategyConfig } from "./strategies";
import { Swarm } from "./swarm";
import { PaperVenue } from "./venues";

export interface Candle {
  /** Bar start, unix ms. */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

const stamp = (s: string): number => {
  const m = s.match(/^(\d{4})(\d{2})(\d{2}) (\d{2})(\d{2})(\d{2})$/);
  if (m) return Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!);
  if (/^\d+(\.\d+)?$/.test(s)) return +s < 1e11 ? +s * 1000 : +s;
  return Date.parse(s);
};

/**
 * Reads candles from text: one per line as time, open, high, low, close, volume,
 * split by commas or semicolons. Time is unix seconds, unix ms, an ISO date or
 * "YYYYMMDD HHMMSS" (UTC). Header and broken lines are skipped; output is oldest first.
 */
export function parseCandles(text: string): Candle[] {
  const out: Candle[] = [];
  for (const line of text.split(/\r?\n/)) {
    const f = line.trim().split(/[;,]/).map((x) => x.trim());
    if (f.length < 5) continue;
    const t = stamp(f[0]!);
    const [o, h, l, c] = [+f[1]!, +f[2]!, +f[3]!, +f[4]!];
    if (!Number.isFinite(t) || !(o > 0 && h > 0 && l > 0 && c > 0)) continue;
    out.push({ t, o, h, l, c, v: Number(f[5] ?? 0) || 0 });
  }
  return out.sort((a, b) => a.t - b.t);
}

/** A feed the backtest pushes candles into: four quotes per candle, so bars get real highs and lows. */
export class ReplayFeed implements PriceFeed {
  readonly kind = "replay";
  private hist: Quote[] = [];
  constructor(readonly mint: string) {}
  push(c: Candle, stepMs: number) {
    const mid = c.c >= c.o ? [c.l, c.h] : [c.h, c.l];
    const prices = [c.o, mid[0]!, mid[1]!, c.c];
    prices.forEach((p, i) => this.hist.push({ priceSol: p, decimals: 6, ts: c.t + Math.round(((i + 1) * (stepMs - 1)) / 4) }));
    if (this.hist.length > 480) this.hist.splice(0, this.hist.length - 480);
  }
  async refresh() {}
  latest(mint: string) {
    return mint === this.mint ? this.hist[this.hist.length - 1] : undefined;
  }
  history(mint: string) {
    return mint === this.mint ? this.hist : [];
  }
}

export interface BacktestOptions {
  strategy: StrategyConfig;
  bankrollSol?: number;
  /** Fee per trade, in basis points. */
  feeBps?: number;
  /** Paper slippage; half is charged on each side. */
  slippageBps?: number;
  /**
   * Candles carry no wallets, so the flow strategy has nothing to follow. This
   * stands in for buy pressure: an up candle on at least volX times the average
   * volume of the last `bars` candles. A rough proxy, labelled as one in results.
   */
  flowProxy?: { volX: number; bars: number };
}

export interface BacktestResult {
  candles: number;
  returnPct: number;
  buyHoldPct: number;
  maxDrawdownPct: number;
  /** Completed sells. */
  sells: number;
  winRatePct: number;
  /** Share of time with an open position. */
  exposurePct: number;
}

const MINT = "So11111111111111111111111111111111111111112";

export async function backtest(candles: Candle[], o: BacktestOptions): Promise<BacktestResult> {
  if (candles.length < 2) throw new Error("need at least two candles");
  const stepMs = Math.max(1000, candles[1]!.t - candles[0]!.t);
  const feed = new ReplayFeed(MINT);
  let now = candles[0]!.t;
  const cfg = parseConfig({
    logFile: null,
    killFile: "/nonexistent/SWARM_STOP",
    risk: { maxTxPerMin: 600, slippageBps: o.slippageBps ?? 300, feeBps: o.feeBps ?? 100 },
    coordination: { noSelfTradeMs: 0 },
    groups: [{ preset: "momentum", bankrollSol: o.bankrollSol ?? 1, targets: [MINT], tasks: ["trade"] }],
  });
  const spec = { ...expandGroups(cfg.groups)[0]!, strategy: o.strategy };
  let sells = 0;
  const emit = (l: Record<string, unknown>) => {
    if (l.event === "fill" && l.side === "sell") sells++;
  };
  const swarm = new Swarm(cfg, [spec], { feed, now: () => now, emit, venue: (l) => new PaperVenue(l, cfg.risk.slippageBps, cfg.risk.feeBps) });
  const book = swarm.ledger.book(spec.id);
  const price = (m: string) => feed.latest(m)?.priceSol;
  let peak = book.startSol;
  let maxDd = 0;
  let exposed = 0;
  const vols: number[] = [];
  for (const c of candles) {
    feed.push(c, stepMs);
    now = c.t + stepMs - 1;
    const fp = o.flowProxy;
    if (fp && vols.length >= fp.bars) {
      const avg = vols.slice(-fp.bars).reduce((a, b) => a + b, 0) / fp.bars;
      if (avg > 0 && c.c > c.o && c.v >= fp.volX * avg) swarm.board.post({ mint: MINT, kind: "buy_pressure", severity: "low", score: Math.min(1, c.v / (fp.volX * avg * 4)), reasons: [`volume ${(c.v / avg).toFixed(1)}x average on an up candle (proxy)`], from: "backtest", ts: now, ttlMs: 2 * stepMs });
    }
    vols.push(c.v);
    if (vols.length > 500) vols.shift();
    await swarm.tick();
    const eq = swarm.ledger.equity(spec.id, price);
    peak = Math.max(peak, eq);
    maxDd = Math.max(maxDd, 1 - eq / peak);
    if (book.positions.size) exposed++;
  }
  const eq = swarm.ledger.equity(spec.id, price);
  return {
    candles: candles.length,
    returnPct: (eq / book.startSol - 1) * 100,
    buyHoldPct: (candles[candles.length - 1]!.c / candles[0]!.o - 1) * 100,
    maxDrawdownPct: maxDd * 100,
    sells,
    winRatePct: sells ? (book.wins / sells) * 100 : 0,
    exposurePct: (exposed / candles.length) * 100,
  };
}
