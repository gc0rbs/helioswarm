// Trading styles. Four rule-based strategies, each a short list of numbers a
// sponsor can tune, sharing one sizing and risk layer:
//
//   trend       buy a breakout above the recent range, trail a stop behind it
//   reversion   buy a sharp dip below the rolling mean, sell when it snaps back
//   flow        follow on-chain buy pressure, take profit fast, leave on a time stop
//   accumulate  buy in slices while the long trend is up, step aside when it breaks
//
// Every default is tied to a source in docs/strategies.md. Where the source
// gives a direction but no number, the doc says the number is a judgment call.
import type { Action, Brain, BrainInput } from "./brain";
import type { PriceFeed } from "./feeds";
import type { PsychologyId } from "./types";

export type StrategyId = "trend" | "reversion" | "flow" | "accumulate";
export type RiskProfile = "cautious" | "balanced" | "aggressive";

export interface ParamSpec {
  default: number;
  min: number;
  max: number;
  int?: boolean;
  help: string;
}

export interface StrategyConfig {
  id: StrategyId;
  profile: RiskProfile;
  /** Every parameter of the strategy, defaults filled in and the profile applied. */
  params: Record<string, number>;
}

const P = (dflt: number, min: number, max: number, help: string, int = false): ParamSpec => ({ default: dflt, min, max, help, ...(int ? { int } : {}) });

/** Sizing and risk settings every strategy shares. A strategy may change the defaults. */
const COMMON: Record<string, ParamSpec> = {
  barSec: P(60, 5, 86_400, "Length of one price bar in seconds. All *Bars settings count these.", true),
  riskPct: P(1, 0.1, 5, "Percent of the agent's equity lost if a trade hits its stop. Buy size = equity x riskPct / stop distance."),
  maxPositionPct: P(20, 1, 100, "Most of the agent's equity that may sit in one coin, in percent."),
  stopPct: P(15, 2, 60, "Hard stop: sell the whole position once it is down this many percent from its average entry."),
  trailPct: P(0, 0, 60, "Trailing stop: sell once price falls this many percent from its high since entry. 0 turns it off."),
  maxHoldBars: P(0, 0, 100_000, "Time stop: sell after holding this many bars. 0 turns it off.", true),
  cooldownBars: P(10, 0, 10_000, "Bars to wait before buying a coin again after selling it.", true),
  costBps: P(200, 0, 2_000, "Round-trip trading cost you expect (fees plus slippage, both sides), in basis points. Entries that cannot beat it are skipped."),
  minOrderSol: P(0.01, 0, 10, "Smallest buy worth sending. Smaller sizes are skipped, since fixed network fees eat them."),
  maxLossStreak: P(3, 0, 50, "Losing sells in a row that pause new buys. 0 turns it off.", true),
  pauseBars: P(60, 0, 100_000, "How long that pause lasts, in bars.", true),
  dailyLossPct: P(5, 0, 100, "Stop buying for the rest of the UTC day once equity is down this many percent on the day. 0 turns it off."),
};

export interface StrategyDef {
  id: StrategyId;
  name: string;
  summary: string;
  /** One line per source the defaults lean on. Full citations are in docs/strategies.md. */
  basis: string[];
  params: Record<string, ParamSpec>;
}

const def = (id: StrategyId, name: string, summary: string, basis: string[], common: Record<string, number>, own: Record<string, ParamSpec>): StrategyDef => {
  const params: Record<string, ParamSpec> = {};
  for (const [k, spec] of Object.entries(COMMON)) params[k] = { ...spec, default: common[k] ?? spec.default };
  return { id, name, summary, basis, params: { ...params, ...own } };
};

export const STRATEGIES: Record<StrategyId, StrategyDef> = {
  trend: def(
    "trend",
    "Trend",
    "Buys when price closes above its recent range and rides the move with a stop that trails behind it.",
    ["Moskowitz, Ooi, Pedersen (2012), Time series momentum", "Liu, Tsyvinski (2021), Risks and returns of cryptocurrency", "Donchian channel breakout as used in the Turtle rules", "Han, Zhou, Zhu (2016), Taming momentum crashes: a simple stop-loss strategy"],
    { barSec: 14_400, stopPct: 12, maxHoldBars: 0, cooldownBars: 3, pauseBars: 12 },
    {
      entryBars: P(20, 5, 500, "Buy when a bar closes above the highest high of this many bars before it.", true),
      exitBars: P(10, 2, 250, "Sell when a bar closes below the lowest low of this many bars before it.", true),
      trendBars: P(50, 0, 1_000, "Only buy while price is above its average over this many bars. 0 turns the filter off.", true),
      atrBars: P(14, 5, 200, "Bars used to measure the coin's typical range (ATR).", true),
      stopAtr: P(2, 0.5, 10, "Initial stop distance in ATRs, never wider than stopPct."),
      trailAtr: P(3, 0, 20, "Trailing stop distance in ATRs from the high since entry. 0 turns it off."),
    },
  ),
  reversion: def(
    "reversion",
    "Reversion",
    "Buys a sharp drop below the rolling average while the longer trend holds, and sells when price comes back to the average.",
    ["Lehmann (1990) and Jegadeesh (1990), short-term reversal", "Avellaneda, Lee (2010), Statistical arbitrage in the US equities market", "Bianchi, Babiak, Dickerson (2022), Trading volume and liquidity provision in cryptocurrency markets", "Connors RSI(2): only fade dips above the long average"],
    { barSec: 300, stopPct: 12, maxHoldBars: 30, cooldownBars: 12 },
    {
      lookbackBars: P(20, 10, 500, "Bars in the rolling average and standard deviation.", true),
      entryZ: P(-2, -6, -0.5, "Buy when price is this many standard deviations below the average."),
      exitZ: P(-0.5, -2, 2, "Sell when price is back to this many standard deviations from the average."),
      trendBars: P(200, 0, 2_000, "Only buy while the lookbackBars average is above the average over this many bars. 0 turns the filter off.", true),
      edgeX: P(2.5, 0, 10, "Only buy when the distance back to the average is at least this many times costBps."),
    },
  ),
  flow: def(
    "flow",
    "Flow",
    "Buys when many distinct wallets are buying on-chain and price confirms, sells part into strength and leaves quickly when the flow fades. Needs the on-chain stream.",
    ["Kyle (1985) and Cont, Kukanov, Stoikov (2014), order flow and price impact", "Chordia, Subrahmanyam (2004), Order imbalance and individual stock returns", "Li, Shin, Wang (2025), Cryptocurrency pump-and-dump schemes: gains fade within the hour", "Marino et al. (2026) and Solidus Labs (2025), pump.fun base rates"],
    { barSec: 60, stopPct: 15, trailPct: 20, maxHoldBars: 15, cooldownBars: 10 },
    {
      minScore: P(0.25, 0, 1, "Weakest buy_pressure signal worth following (0 to 1). The signal itself is tuned under signals in the config."),
      confirmBars: P(3, 1, 100, "Price must be up over this many bars before buying.", true),
      chaseBars: P(15, 1, 500, "Window for the chase limit below.", true),
      maxChasePct: P(40, 1, 1_000, "Skip the buy when price is already up more than this many percent over chaseBars."),
      edgeX: P(2, 0, 10, "Only buy when the coin's typical move over the hold window is at least this many times costBps."),
      tp1Pct: P(30, 1, 1_000, "First profit target, in percent."),
      tp1Frac: P(0.4, 0, 1, "Share of the position sold at the first target."),
      tp2Pct: P(75, 1, 10_000, "Second profit target, in percent."),
      tp2Frac: P(0.5, 0, 1, "Share of what is left sold at the second target. The rest rides the trailing stop."),
    },
  ),
  accumulate: def(
    "accumulate",
    "Accumulate",
    "Buys a fixed slice on a schedule while the long trend is up, stops buying when it turns and sells out if it breaks.",
    ["Faber (2007), A quantitative approach to tactical asset allocation", "Constantinides (1979) and Vanguard (2012) on dollar-cost averaging", "Moreira, Muir (2017), Volatility-managed portfolios"],
    { barSec: 14_400, stopPct: 25, maxPositionPct: 30, cooldownBars: 6, maxLossStreak: 2, pauseBars: 18 },
    {
      everyBars: P(6, 1, 10_000, "Bars between buys.", true),
      slicePct: P(5, 0.1, 100, "Size of each buy, as a percent of the agent's equity."),
      trendBars: P(60, 2, 5_000, "Buy only while price is above its average over this many bars.", true),
      exitBandPct: P(5, 0, 50, "Sell everything once price closes this many percent below that average."),
    },
  ),
};

export const STRATEGY_IDS = Object.keys(STRATEGIES) as StrategyId[];

/** The style each psychology preset trades when a group names no strategy. */
export const STRATEGY_BY_PRESET: Record<PsychologyId, StrategyId> = {
  degen: "flow",
  momentum: "trend",
  holder: "accumulate",
  contrarian: "reversion",
  sniper: "flow",
  showman: "trend",
};

const PROFILE_SCALE: Record<RiskProfile, number> = { cautious: 0.5, balanced: 1, aggressive: 2 };

/** A preset's risk trait (0 to 255) picks how hard it sizes. */
export const profileForRisk = (risk: number): RiskProfile => (risk < 100 ? "cautious" : risk < 180 ? "balanced" : "aggressive");

/**
 * Reads a group's "strategy": a name, or { id, profile, params }. Unknown
 * parameters and numbers outside their range are errors, so a typo never
 * silently trades the default.
 */
export function parseStrategy(x: unknown, label: string, fallback: { id: StrategyId; profile: RiskProfile }): StrategyConfig {
  const o = (typeof x === "string" ? { id: x } : (x ?? {})) as Record<string, unknown>;
  if (typeof o !== "object" || Array.isArray(o)) throw new Error(`${label} must be a strategy name or an object`);
  const id = (o.id ?? fallback.id) as StrategyId;
  if (!STRATEGY_IDS.includes(id)) throw new Error(`${label} must be one of ${STRATEGY_IDS.join(", ")}`);
  const profile = (o.profile ?? fallback.profile) as RiskProfile;
  if (!(profile in PROFILE_SCALE)) throw new Error(`${label}.profile must be cautious, balanced or aggressive`);
  const specs = STRATEGIES[id].params;
  const given = (o.params ?? {}) as Record<string, unknown>;
  if (typeof given !== "object" || Array.isArray(given)) throw new Error(`${label}.params must be an object`);
  for (const k of Object.keys(given)) if (!(k in specs)) throw new Error(`${label}.params.${k} is not a setting of the ${id} strategy (it has: ${Object.keys(specs).join(", ")})`);
  const params: Record<string, number> = {};
  const scale = PROFILE_SCALE[profile];
  for (const [k, s] of Object.entries(specs)) {
    const v = given[k];
    if (v === undefined) {
      // The profile scales only how much is put at risk, never the signal.
      const scaled = k === "riskPct" || k === "maxPositionPct" || k === "slicePct" ? s.default * scale : s.default;
      params[k] = Math.min(s.max, Math.max(s.min, scaled));
      continue;
    }
    if (typeof v !== "number" || !Number.isFinite(v) || v < s.min || v > s.max) throw new Error(`${label}.params.${k} must be a number between ${s.min} and ${s.max}`);
    params[k] = s.int ? Math.round(v) : v;
  }
  if (id === "trend" && params.exitBars! > params.entryBars!) throw new Error(`${label}.params.exitBars must not be longer than entryBars`);
  if (id === "reversion" && params.exitZ! <= params.entryZ!) throw new Error(`${label}.params.exitZ must be above entryZ`);
  if (id === "flow" && params.tp2Pct! <= params.tp1Pct!) throw new Error(`${label}.params.tp2Pct must be above tp1Pct`);
  return { id, profile, params };
}

export const defaultStrategy = (id: StrategyId, profile: RiskProfile = "balanced"): StrategyConfig => parseStrategy({ id, profile }, "strategy", { id, profile });

/** The strategy in plain sentences, for the agent's prompt and for --strategies. */
export function describeStrategy(s: StrategyConfig): string {
  const d = STRATEGIES[s.id];
  const p = s.params;
  const risk = `Risks ${p.riskPct}% of equity per trade, at most ${p.maxPositionPct}% in one coin, hard stop at -${p.stopPct}%.`;
  const how: Record<StrategyId, string> = {
    trend: `Buys a close above the ${p.entryBars}-bar high${p.trendBars ? ` while price is above its ${p.trendBars}-bar average` : ""}; sells on a close below the ${p.exitBars}-bar low or ${p.trailAtr} ATR off the high.`,
    reversion: `Buys ${Math.abs(p.entryZ!)} standard deviations below the ${p.lookbackBars}-bar average${p.trendBars ? ` while that average is above the ${p.trendBars}-bar one` : ""}; sells back at ${p.exitZ} or after ${p.maxHoldBars} bars.`,
    flow: `Buys on a buy_pressure signal of at least ${p.minScore} with price up over ${p.confirmBars} bars and not already up ${p.maxChasePct}%; sells ${Math.round(p.tp1Frac! * 100)}% at +${p.tp1Pct}%, more at +${p.tp2Pct}%, the rest ${p.trailPct}% off the high or after ${p.maxHoldBars} bars.`,
    accumulate: `Buys ${p.slicePct}% of equity every ${p.everyBars} bars while price is above its ${p.trendBars}-bar average; sells out ${p.exitBandPct}% below it.`,
  };
  return `${d.name} (${s.profile}, ${p.barSec}s bars). ${how[s.id]} ${risk}`;
}

export interface Bar {
  /** Bar start, unix ms. */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

/** Builds fixed-length bars from a stream of prices. The last bar is still forming. */
export class BarSeries {
  readonly bars: Bar[] = [];
  private lastTs = -Infinity;
  constructor(readonly barMs: number, private keep = 2_500) {}

  add(ts: number, price: number) {
    if (!(price > 0) || ts <= this.lastTs) return;
    this.lastTs = ts;
    const t = Math.floor(ts / this.barMs) * this.barMs;
    const last = this.bars[this.bars.length - 1];
    if (last && last.t === t) {
      last.h = Math.max(last.h, price);
      last.l = Math.min(last.l, price);
      last.c = price;
    } else {
      this.bars.push({ t, o: price, h: price, l: price, c: price });
      if (this.bars.length > this.keep) this.bars.shift();
    }
  }

  /** Takes every quote in the feed's history that is newer than the last one seen. */
  sync(feed: PriceFeed, mint: string) {
    const h = feed.history(mint);
    let i = h.length;
    while (i > 0 && h[i - 1]!.ts > this.lastTs) i--;
    for (; i < h.length; i++) this.add(h[i]!.ts, h[i]!.priceSol);
  }

  /** Finished bars only, oldest first. */
  get done(): Bar[] {
    return this.bars.slice(0, -1);
  }
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

/** Average of the last n closes. */
export function sma(bars: Bar[], n: number): number {
  return mean(bars.slice(-n).map((b) => b.c));
}

/** Average true range over the last n bars, as a fraction of the last close. */
export function atrPct(bars: Bar[], n: number): number {
  const xs = bars.slice(-(n + 1));
  if (xs.length < 2) return 0;
  const tr: number[] = [];
  for (let i = 1; i < xs.length; i++) tr.push(Math.max(xs[i]!.h, xs[i - 1]!.c) - Math.min(xs[i]!.l, xs[i - 1]!.c));
  const last = xs[xs.length - 1]!.c;
  return last > 0 ? mean(tr) / last : 0;
}

/** How many standard deviations `price` sits from the mean of the last n closes. */
export function zScore(bars: Bar[], n: number, price: number): { z: number; mean: number } {
  const xs = bars.slice(-n).map((b) => b.c);
  const m = mean(xs);
  const sd = Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
  return { z: sd > 0 ? (price - m) / sd : 0, mean: m };
}

interface Held {
  peak: number;
  /** Profit targets already taken (flow). */
  rungs: number;
  /** Stop distance fixed at entry, as a fraction. */
  stop: number;
  trimmed?: boolean;
}

interface Entry {
  mint: string;
  /** Stop distance as a fraction of price. */
  stop: number;
  /** Higher is better when several targets qualify. */
  strength: number;
  reason: string;
  /** Fixed size as a fraction of equity (accumulate) instead of risk-based sizing. */
  slice?: number;
}

const pc = (x: number) => `${(x * 100).toFixed(1)}%`;

/** Trades one strategy for one agent. Holds its own bars and per-position state. */
export class StrategyBrain implements Brain {
  readonly kind = "strategy";
  private series = new Map<string, BarSeries>();
  private held = new Map<string, Held>();
  private cooldown = new Map<string, number>();
  private lastEval = new Map<string, number>();
  private lastBuy = new Map<string, number>();
  private realized = 0;
  private streak = 0;
  private pausedUntil = 0;
  private day = -1;
  private dayStart = 0;

  constructor(readonly cfg: StrategyConfig) {}

  private get barMs() {
    return this.cfg.params.barSec! * 1000;
  }

  private bars(feed: PriceFeed, mint: string): BarSeries {
    let s = this.series.get(mint);
    if (!s) this.series.set(mint, (s = new BarSeries(this.barMs)));
    s.sync(feed, mint);
    return s;
  }

  /** Most finished bars any signal of this strategy looks back over. */
  get warmupBars(): number {
    const p = this.cfg.params;
    return Math.max(p.entryBars ?? 0, p.trendBars ?? 0, p.lookbackBars ?? 0, p.chaseBars ?? 0, (p.atrBars ?? 0) + 1) + 2;
  }

  /**
   * Fills a coin's bars from past candles before the first tick. Candles may be
   * priced in another currency (USD): they are rescaled so the last close equals
   * `priceNow`, which keeps their shape and ignores the currency's own drift.
   * Does nothing once the coin has live bars.
   */
  seed(mint: string, candles: { t: number; o: number; h: number; l: number; c: number }[], priceNow: number, now: number) {
    if (this.series.has(mint) || !candles.length || !(priceNow > 0)) return;
    const k = priceNow / candles[candles.length - 1]!.c;
    const step = candles.length > 1 ? candles[1]!.t - candles[0]!.t : this.barMs;
    const s = new BarSeries(this.barMs);
    for (const c of candles) {
      if (c.t + step > now) break;
      const mid = c.c >= c.o ? [c.l, c.h] : [c.h, c.l];
      [c.o, mid[0]!, mid[1]!, c.c].forEach((x, i) => s.add(c.t + Math.round(((i + 1) * (step - 1)) / 4), x * k));
    }
    this.series.set(mint, s);
  }

  private equity({ book, feed }: BrainInput): number {
    let v = book.cashSol;
    for (const p of book.positions.values()) v += p.tokens * (feed.latest(p.mint)?.priceSol ?? 0);
    return v;
  }

  /** Largest buy of this coin the risk settings allow right now, for a stop this far away. */
  sizeFor(input: BrainInput, mint: string, stop: number, slice?: number): number {
    const p = this.cfg.params;
    const equity = this.equity(input);
    const heldCost = input.book.positions.get(mint)?.costSol ?? 0;
    const want = slice != null ? equity * slice : (equity * p.riskPct!) / 100 / Math.max(stop, 0.005);
    return Math.max(0, Math.min(want, (equity * p.maxPositionPct!) / 100 - heldCost, input.maxBuySol, input.book.cashSol));
  }

  /** Caps a buy another brain proposes at this strategy's size limit. */
  clamp(input: BrainInput, a: Action): Action {
    if (a.kind !== "buy") return a;
    const sol = Math.min(a.sol, this.sizeFor(input, a.mint, this.cfg.params.stopPct! / 100));
    return sol >= this.cfg.params.minOrderSol! && sol > 0 ? { ...a, sol } : { kind: "hold", reason: "over this agent's position limit" };
  }

  async decide(input: BrainInput): Promise<Action> {
    const { agent, book, feed, board, now } = input;
    const p = this.cfg.params;
    for (const t of agent.targets) this.bars(feed, t.mint);

    // Book-keeping: wins and losses since last time, closed positions, the day's start.
    if (book.realizedSol < this.realized - 1e-12) this.streak++;
    else if (book.realizedSol > this.realized + 1e-12) this.streak = 0;
    this.realized = book.realizedSol;
    if (p.maxLossStreak! > 0 && this.streak >= p.maxLossStreak!) {
      this.pausedUntil = now + p.pauseBars! * this.barMs;
      this.streak = 0;
    }
    for (const mint of [...this.held.keys()]) {
      if (book.positions.has(mint)) continue;
      this.held.delete(mint);
      this.cooldown.set(mint, now + p.cooldownBars! * this.barMs);
    }
    const equity = this.equity(input);
    const day = Math.floor(now / 86_400_000);
    if (day !== this.day) {
      this.day = day;
      this.dayStart = equity;
    }

    for (const pos of book.positions.values()) {
      const exit = this.exit(input, pos.mint);
      if (exit) return exit;
    }

    if (now < this.pausedUntil) return { kind: "hold", reason: "paused after a losing streak" };
    if (p.dailyLossPct! > 0 && equity < this.dayStart * (1 - p.dailyLossPct! / 100)) return { kind: "hold", reason: "daily loss limit reached" };
    if (input.maxBuySol <= 0) return { kind: "hold", reason: "no cash to spend" };

    let best: Entry | null = null;
    for (const t of agent.targets) {
      if ((this.cooldown.get(t.mint) ?? 0) > now) continue;
      if (board?.buyBlock(agent.id, t.mint, now)) continue;
      const e = this.entry(input, t.mint);
      if (e && (!best || e.strength > best.strength)) best = e;
    }
    if (!best) return { kind: "hold", reason: "no setup" };
    const sol = this.sizeFor(input, best.mint, best.stop, best.slice);
    if (sol <= 0 || sol < p.minOrderSol!) return { kind: "hold", reason: "setup found but the size is too small to send" };
    this.lastBuy.set(best.mint, now);
    const h = this.held.get(best.mint);
    const price = feed.latest(best.mint)!.priceSol;
    if (!h) this.held.set(best.mint, { peak: price, rungs: 0, stop: best.stop });
    return { kind: "buy", mint: best.mint, sol, reason: best.reason.slice(0, 120) };
  }

  private exit(input: BrainInput, mint: string): Action | null {
    const { book, feed, board, now } = input;
    const p = this.cfg.params;
    const pos = book.positions.get(mint)!;
    const q = feed.latest(mint);
    if (!q || pos.tokens <= 0) return null;
    const price = q.priceSol;
    const entry = pos.costSol / pos.tokens;
    let h = this.held.get(mint);
    if (!h) this.held.set(mint, (h = { peak: Math.max(price, entry), rungs: 0, stop: p.stopPct! / 100 }));
    h.peak = Math.max(h.peak, price);
    const pnl = price / entry - 1;
    const sell = (fraction: number, reason: string): Action => ({ kind: "sell", mint, fraction, reason: reason.slice(0, 120) });

    if (board) {
      const s = board.active(mint, now).find((x) => board.cfg.exitOn.includes(x.kind) || x.kind === "sell_pressure");
      if (s) {
        const soft = s.kind === "sell_pressure" && s.severity === "low" && this.cfg.id !== "flow";
        if (!soft) return sell(1, `${s.kind}: ${s.reasons[0] ?? ""}`);
        if (!h.trimmed) {
          h.trimmed = true;
          return sell(0.5, `${s.kind}: ${s.reasons[0] ?? ""}`);
        }
      }
    }
    if (pnl <= -Math.min(h.stop, p.stopPct! / 100)) return sell(1, `stop at ${pc(pnl)}`);

    const done = this.series.get(mint)?.done ?? [];
    let trail = p.trailPct! / 100;
    // A stop closer than a few round trips of cost is set off by noise, so it is floored there.
    if (this.cfg.id === "trend" && p.trailAtr! > 0 && done.length > p.atrBars!) trail = Math.min(p.stopPct! / 100, Math.max(0.02, (3 * p.costBps!) / 10_000, p.trailAtr! * atrPct(done, p.atrBars!)));
    if (trail > 0 && price <= h.peak * (1 - trail)) return sell(1, `trailing stop, ${pc(price / h.peak - 1)} off the high`);
    if (p.maxHoldBars! > 0 && now - pos.openedAt >= p.maxHoldBars! * this.barMs) return sell(1, `time stop after ${p.maxHoldBars} bars (${pc(pnl)})`);

    const last = done[done.length - 1];
    if (this.cfg.id === "trend" && last && done.length > p.exitBars!) {
      const low = Math.min(...done.slice(-p.exitBars! - 1, -1).map((b) => b.l));
      if (last.c < low) return sell(1, `closed below the ${p.exitBars}-bar low (${pc(pnl)})`);
    }
    if (this.cfg.id === "reversion" && done.length >= p.lookbackBars!) {
      const { z } = zScore(done, p.lookbackBars!, price);
      if (z >= p.exitZ!) return sell(1, `back to the average, z ${z.toFixed(1)} (${pc(pnl)})`);
    }
    if (this.cfg.id === "flow") {
      if (h.rungs === 0 && pnl >= p.tp1Pct! / 100) {
        h.rungs = 1;
        if (p.tp1Frac! > 0) return sell(p.tp1Frac!, `first target, up ${pc(pnl)}`);
      }
      if (h.rungs === 1 && pnl >= p.tp2Pct! / 100) {
        h.rungs = 2;
        if (p.tp2Frac! > 0) return sell(p.tp2Frac!, `second target, up ${pc(pnl)}`);
      }
    }
    if (this.cfg.id === "accumulate" && last && done.length >= p.trendBars!) {
      const avg = sma(done, p.trendBars!);
      if (last.c < avg * (1 - p.exitBandPct! / 100)) return sell(1, `closed ${pc(last.c / avg - 1)} under the ${p.trendBars}-bar average`);
    }
    return null;
  }

  private entry(input: BrainInput, mint: string): Entry | null {
    const { book, feed, board, now } = input;
    const p = this.cfg.params;
    const series = this.series.get(mint)!;
    const done = series.done;
    const q = feed.latest(mint);
    const last = done[done.length - 1];
    if (!q || !last) return null;
    const price = q.priceSol;
    const cost = p.costBps! / 10_000;
    const holding = book.positions.has(mint);
    // Bar strategies look once per finished bar; flow reacts to its signal on any tick.
    const fresh = this.lastEval.get(mint) !== last.t;

    if (this.cfg.id === "flow") {
      if (holding || !board) return null;
      const sig = board.active(mint, now).filter((s) => s.kind === "buy_pressure").sort((a, b) => b.score - a.score)[0];
      if (!sig || sig.score < p.minScore!) return null;
      if (done.length < p.confirmBars!) return null;
      const from = (n: number) => done[Math.max(0, done.length - n)]!.o;
      const up = price / from(p.confirmBars!) - 1;
      const run = price / from(p.chaseBars!) - 1;
      if (up <= 0 || run > p.maxChasePct! / 100) return null;
      // The coin has to move enough inside the hold window to pay for the round trip.
      const reach = atrPct(done, Math.min(14, done.length - 1)) * Math.sqrt(p.maxHoldBars! || 60);
      if (reach < p.edgeX! * cost) return null;
      return { mint, stop: p.stopPct! / 100, strength: sig.score, reason: `flow: ${sig.reasons[0] ?? "buy pressure"}, price up ${pc(up)}` };
    }

    if (!fresh) return null;
    this.lastEval.set(mint, last.t);

    if (this.cfg.id === "trend") {
      const need = Math.max(p.entryBars! + 1, p.trendBars!, p.atrBars! + 1);
      if (holding || done.length < need) return null;
      const high = Math.max(...done.slice(-p.entryBars! - 1, -1).map((b) => b.h));
      if (last.c <= high) return null;
      if (p.trendBars! > 0 && last.c <= sma(done, p.trendBars!)) return null;
      const atr = atrPct(done, p.atrBars!);
      const stop = Math.min(p.stopPct! / 100, Math.max(0.02, 2 * cost, p.stopAtr! * atr));
      return { mint, stop, strength: last.c / high - 1, reason: `trend: closed ${pc(last.c / high - 1)} above the ${p.entryBars}-bar high` };
    }

    if (this.cfg.id === "reversion") {
      const need = Math.max(p.lookbackBars!, p.trendBars!);
      if (holding || done.length < need) return null;
      const { z, mean: m } = zScore(done, p.lookbackBars!, price);
      if (z > p.entryZ!) return null;
      if (p.trendBars! > 0 && sma(done, p.lookbackBars!) < sma(done, p.trendBars!)) return null;
      const room = m / price - 1;
      if (room < p.edgeX! * cost) return null;
      return { mint, stop: p.stopPct! / 100, strength: -z, reason: `reversion: ${z.toFixed(1)} sd under the average, ${pc(room)} back to it` };
    }

    // accumulate
    if (done.length < p.trendBars!) return null;
    const since = this.lastBuy.get(mint);
    if (since != null && now - since < p.everyBars! * this.barMs) return null;
    const avg = sma(done, p.trendBars!);
    if (last.c <= avg) return null;
    return { mint, stop: p.stopPct! / 100, strength: last.c / avg - 1, slice: p.slicePct! / 100, reason: `accumulate: ${pc(last.c / avg - 1)} above the ${p.trendBars}-bar average` };
  }
}
