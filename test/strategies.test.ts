import { describe, expect, it } from "vitest";

import {
  atrPct,
  backtest,
  BarSeries,
  Board,
  candleSizeFor,
  ClaudeBrain,
  DEFAULT_COORDINATION,
  defaultStrategy,
  describeStrategy,
  expandGroups,
  Ledger,
  PaperVenue,
  parseCandles,
  parseConfig,
  parseStrategy,
  poolCandles,
  STRATEGIES,
  STRATEGY_IDS,
  StrategyBrain,
  topPool,
  zScore,
  type Action,
  type AgentSpec,
  type Candle,
  type PriceFeed,
  type Quote,
  type StrategyConfig,
} from "../src";

const MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const MIN = 60_000;

class TestFeed implements PriceFeed {
  readonly kind = "test";
  hist: Quote[] = [];
  push(priceSol: number, ts: number) {
    this.hist.push({ priceSol, ts, decimals: 6 });
  }
  async refresh() {}
  latest() {
    return this.hist[this.hist.length - 1];
  }
  history() {
    return this.hist;
  }
}

const strat = (id: string, params: Record<string, number> = {}, profile = "balanced"): StrategyConfig => parseStrategy({ id, profile, params: { barSec: 60, costBps: 0, minOrderSol: 0, ...params } }, "s", { id: "trend", profile: "balanced" });

/** Runs one price per minute through a brain with free fills, and returns every action it took. */
async function run(cfg: StrategyConfig, prices: number[], opts: { bankroll?: number; signal?: (i: number, board: Board, now: number) => void } = {}) {
  const feed = new TestFeed();
  const ledger = new Ledger();
  const agent = { id: "a", name: "a", targets: [{ mint: MINT, symbol: "T" }], strategy: cfg } as unknown as AgentSpec;
  ledger.open("a", opts.bankroll ?? 1);
  const board = new Board(ledger, [agent], { ...DEFAULT_COORDINATION, noSelfTradeMs: 0 });
  const venue = new PaperVenue(ledger, 0, 0);
  const brain = new StrategyBrain(cfg);
  const actions: (Action & { i: number })[] = [];
  for (let i = 0; i < prices.length; i++) {
    const now = (i + 1) * MIN - 1;
    feed.push(prices[i]!, now);
    opts.signal?.(i, board, now);
    const book = ledger.book("a");
    const a = await brain.decide({ agent, book, feed, maxBuySol: book.cashSol, now, board });
    const ctx = { agent: "a", group: 0, reason: a.reason, now };
    if (a.kind === "buy") await venue.buy(ctx, MINT, a.sol, feed.latest()!);
    if (a.kind === "sell") await venue.sell(ctx, MINT, a.fraction, feed.latest()!);
    if (a.kind !== "hold") actions.push({ ...a, i });
  }
  return { actions, book: ledger.book("a"), brain, feed, agent, board };
}

const flat = (n: number, p = 1) => Array.from({ length: n }, (_, i) => p * (1 + (i % 2 ? 0.001 : -0.001)));
const ramp = (n: number, from: number, to: number) => Array.from({ length: n }, (_, i) => from + ((to - from) * (i + 1)) / n);

describe("strategy config", () => {
  it("fills defaults, scales size by profile and rejects typos and bad numbers", () => {
    const base = defaultStrategy("trend");
    expect(base.params.entryBars).toBe(20);
    expect(defaultStrategy("trend", "cautious").params.riskPct).toBe(base.params.riskPct! / 2);
    expect(defaultStrategy("trend", "aggressive").params.riskPct).toBe(base.params.riskPct! * 2);
    expect(defaultStrategy("trend", "aggressive").params.entryBars).toBe(20);
    expect(() => parseStrategy({ id: "trend", params: { entryBar: 10 } }, "s", base)).toThrow(/entryBar is not a setting/);
    expect(() => parseStrategy({ id: "trend", params: { riskPct: 50 } }, "s", base)).toThrow(/between 0.1 and 5/);
    expect(() => parseStrategy("scalp", "s", base)).toThrow(/one of trend, reversion, flow, accumulate/);
    expect(() => parseStrategy({ id: "trend", params: { exitBars: 30 } }, "s", base)).toThrow(/exitBars/);
    for (const id of STRATEGY_IDS) {
      expect(describeStrategy(defaultStrategy(id))).toContain(STRATEGIES[id].name);
      expect(STRATEGIES[id].basis.length).toBeGreaterThan(1);
    }
  });

  it("gives each preset a style and lets a group override it", () => {
    const group = (extra: object) => parseConfig({ groups: [{ bankrollSol: 1, targets: [MINT], ...extra }] }).groups;
    const byPreset = (preset: string) => expandGroups(group({ preset }))[0]!;
    expect(byPreset("momentum").strategy.id).toBe("trend");
    expect(byPreset("contrarian").strategy.id).toBe("reversion");
    expect(byPreset("sniper").strategy.id).toBe("flow");
    expect(byPreset("holder").strategy).toMatchObject({ id: "accumulate", profile: "cautious" });
    expect(byPreset("degen").strategy.profile).toBe("aggressive");
    expect(byPreset("momentum").brain).toBe("strategy");
    const tuned = expandGroups(group({ preset: "degen", strategy: { id: "reversion", profile: "cautious", params: { entryZ: -3 } } }))[0]!;
    expect(tuned.strategy).toMatchObject({ id: "reversion", profile: "cautious" });
    expect(tuned.strategy.params.entryZ).toBe(-3);
    expect(() => group({ preset: "degen", strategy: "yolo" })).toThrow(/strategy must be one of/);
    expect(() => expandGroups(group({ preset: "degen", strategy: { params: { nope: 1 } } }))).toThrow(/nope/);
  });
});

describe("bars and indicators", () => {
  it("builds bars from prices and ignores stale quotes", () => {
    const s = new BarSeries(MIN);
    s.add(1_000, 10);
    s.add(30_000, 12);
    s.add(20_000, 99); // older than the last one
    s.add(59_000, 11);
    s.add(61_000, 13);
    expect(s.done).toEqual([{ t: 0, o: 10, h: 12, l: 10, c: 11 }]);
    expect(s.bars).toHaveLength(2);
  });

  it("measures range and distance from the mean", () => {
    const bars = [1, 2, 3, 4].map((c, i) => ({ t: i, o: c, h: c + 1, l: c - 1, c }));
    expect(atrPct(bars, 3)).toBeCloseTo(2 / 4);
    const z = zScore(bars, 4, 2.5 - Math.sqrt(1.25) * 2);
    expect(z.mean).toBe(2.5);
    expect(z.z).toBeCloseTo(-2);
  });
});

describe("trend", () => {
  const cfg = strat("trend", { entryBars: 5, exitBars: 3, trendBars: 0, atrBars: 5, trailAtr: 0 });

  it("buys the breakout, sizes by risk and sells when the range breaks down", async () => {
    const { actions, book } = await run(cfg, [...flat(10), ...ramp(10, 1.02, 1.3), ...ramp(8, 1.28, 1.0)]);
    expect(actions[0]).toMatchObject({ kind: "buy" });
    expect(actions[0]!.reason).toMatch(/5-bar high/);
    // 1% of 1 SOL at risk, stop floored at 2%: 0.5 SOL wanted, capped at 20% of equity.
    expect((actions[0] as any).sol).toBeCloseTo(0.2);
    const sell = actions.find((a) => a.kind === "sell")!;
    expect(sell.reason).toMatch(/3-bar low/);
    expect(book.positions.size).toBe(0);
    expect(book.realizedSol).toBeGreaterThan(0);
  });

  it("stays out of a flat market and of a falling one", async () => {
    expect((await run(cfg, flat(60))).actions).toHaveLength(0);
    expect((await run(cfg, ramp(60, 1, 0.5))).actions).toHaveLength(0);
  });

  it("sells at the hard stop", async () => {
    const { actions } = await run(strat("trend", { entryBars: 5, exitBars: 2, trendBars: 0, atrBars: 5, trailAtr: 0, stopPct: 5, stopAtr: 10 }), [...flat(10), 1.05, 1.06, 0.9]);
    expect(actions.map((a) => a.kind)).toEqual(["buy", "sell"]);
    expect(actions[1]!.reason).toMatch(/^stop at/);
  });
});

describe("reversion", () => {
  const cfg = strat("reversion", { lookbackBars: 10, trendBars: 0, maxHoldBars: 0 });

  it("buys a sharp dip and sells back at the average", async () => {
    const { actions, book } = await run(cfg, [...flat(15), 0.97, 0.97, 0.985, 0.999, 1.0, 1.0]);
    expect(actions[0]).toMatchObject({ kind: "buy" });
    expect(actions[0]!.reason).toMatch(/sd under the average/);
    expect(actions[1]).toMatchObject({ kind: "sell", fraction: 1 });
    expect(book.realizedSol).toBeGreaterThan(0);
  });

  it("skips dips too small to pay for the round trip", async () => {
    const costly = strat("reversion", { lookbackBars: 10, trendBars: 0, costBps: 200, edgeX: 2.5 });
    expect((await run(costly, [...flat(15), 0.97, 0.97, 1.0])).actions).toHaveLength(0);
  });

  it("does not catch a knife under a falling long average, and leaves on the time stop", async () => {
    const filtered = strat("reversion", { lookbackBars: 10, trendBars: 30 });
    expect((await run(filtered, [...ramp(40, 2, 1), 0.9, 0.9])).actions).toHaveLength(0);
    const timed = strat("reversion", { lookbackBars: 10, trendBars: 0, maxHoldBars: 3 });
    const { actions } = await run(timed, [...flat(15), 0.97, 0.97, 0.97, 0.97, 0.97, 0.97]);
    expect(actions.at(-1)!.reason).toMatch(/time stop/);
  });
});

describe("flow", () => {
  const cfg = strat("flow", { edgeX: 0, maxHoldBars: 0, tp1Pct: 10, tp2Pct: 30, trailPct: 20, minMcapSol: 0 });
  const pressure = (at: number) => (i: number, board: Board, now: number) => {
    if (i === at) board.post({ mint: MINT, kind: "buy_pressure", severity: "low", score: 0.6, reasons: ["12 wallets bought 9 SOL net"], from: "stream", ts: now, ttlMs: 5 * MIN });
  };

  it("never buys without a buy-pressure signal", async () => {
    expect((await run(cfg, ramp(40, 1, 2))).actions).toHaveLength(0);
  });

  it("follows the signal when price confirms, then takes profit in steps and trails the rest", async () => {
    const prices = [...flat(6), 1.01, 1.02, 1.03, 1.15, 1.2, 1.36, 1.4, 1.1];
    const { actions, book } = await run(cfg, prices, { signal: pressure(8) });
    expect(actions.map((a) => a.kind)).toEqual(["buy", "sell", "sell", "sell"]);
    expect(actions[1]).toMatchObject({ fraction: 0.4 });
    expect(actions[2]).toMatchObject({ fraction: 0.5 });
    expect(actions[3]!.reason).toMatch(/trailing stop/);
    expect(book.realizedSol).toBeGreaterThan(0);
  });

  it("skips a signal on a falling price or one that already ran", async () => {
    expect((await run(cfg, [...flat(6), 0.99, 0.98, 0.97, 0.96], { signal: pressure(8) })).actions).toHaveLength(0);
    expect((await run(cfg, [...flat(6), 1.2, 1.4, 1.6, 1.7], { signal: pressure(8) })).actions).toHaveLength(0);
  });

  it("skips coins under its market-cap floor", async () => {
    // Price 1 SOL x 1 billion tokens is far above the floor; the same shape at 1e-7 SOL is a 100 SOL coin.
    const tiny = [...flat(6), 1.01, 1.02, 1.03, 1.15, 1.2].map((x) => x * 1e-7);
    const floor = strat("flow", { edgeX: 0, minMcapSol: 200 });
    expect((await run(floor, tiny, { signal: pressure(8) })).actions).toHaveLength(0);
    expect((await run(strat("flow", { edgeX: 0, minMcapSol: 50 }), tiny, { signal: pressure(8) })).actions[0]).toMatchObject({ kind: "buy" });
    expect(defaultStrategy("flow").params.minMcapSol).toBe(200);
    expect(defaultStrategy("trend").params.minMcapSol).toBe(0);
  });

  it("leaves when the stream flags selling", async () => {
    const { actions } = await run(cfg, [...flat(6), 1.01, 1.02, 1.03, 1.04, 1.05], {
      signal: (i, board, now) => {
        pressure(8)(i, board, now);
        if (i === 10) board.post({ mint: MINT, kind: "sell_pressure", severity: "low", score: 0.3, reasons: ["20% with likely sellers"], from: "stream", ts: now, ttlMs: MIN });
      },
    });
    expect(actions.map((a) => a.kind)).toEqual(["buy", "sell"]);
    expect(actions[1]).toMatchObject({ fraction: 1 });
  });
});

describe("accumulate", () => {
  const cfg = strat("accumulate", { everyBars: 2, slicePct: 10, trendBars: 5, exitBandPct: 3, maxPositionPct: 25, stopPct: 50 });

  it("buys in slices up to its cap while the trend is up, and sells out when it breaks", async () => {
    const { actions, book } = await run(cfg, [...ramp(30, 1, 1.5), ...ramp(6, 1.4, 1.0)]);
    const buys = actions.filter((a) => a.kind === "buy") as Extract<Action, { kind: "buy" }>[];
    expect(buys.length).toBeGreaterThanOrEqual(3);
    expect(buys[0]!.sol).toBeCloseTo(0.1, 1);
    expect(buys.reduce((n, b) => n + b.sol, 0)).toBeLessThanOrEqual(0.3);
    expect(actions.at(-1)).toMatchObject({ kind: "sell", fraction: 1 });
    expect(book.positions.size).toBe(0);
  });

  it("does not buy under the average", async () => {
    expect((await run(cfg, ramp(40, 2, 1))).actions).toHaveLength(0);
  });
});

describe("risk layer", () => {
  it("pauses after a losing streak", async () => {
    const cfg = strat("trend", { entryBars: 5, exitBars: 2, trendBars: 0, atrBars: 5, trailAtr: 0, cooldownBars: 0, maxLossStreak: 2, pauseBars: 1000, dailyLossPct: 0 });
    const fakeout = [...flat(8), 1.05, 1.05, 0.9];
    const { actions } = await run(cfg, [...fakeout, ...fakeout, ...fakeout, ...fakeout]);
    expect(actions.filter((a) => a.kind === "buy")).toHaveLength(2);
  });

  it("stops buying for the day at the daily loss limit", async () => {
    const cfg = strat("trend", { entryBars: 5, exitBars: 2, trendBars: 0, atrBars: 5, trailAtr: 0, cooldownBars: 0, maxLossStreak: 0, dailyLossPct: 2, maxPositionPct: 100, riskPct: 5 });
    const fakeout = [...flat(8), 1.05, 1.05, 0.9];
    const { actions } = await run(cfg, [...fakeout, ...fakeout, ...fakeout]);
    expect(actions.filter((a) => a.kind === "buy")).toHaveLength(1);
  });

  it("skips sizes too small to be worth the network fee", async () => {
    const cfg = strat("trend", { entryBars: 5, exitBars: 3, trendBars: 0, atrBars: 5, minOrderSol: 0.05 });
    expect((await run(cfg, [...flat(10), ...ramp(10, 1.02, 1.3)], { bankroll: 0.1 })).actions).toHaveLength(0);
  });

  it("caps what a model brain may buy and takes over when the model fails", async () => {
    const cfg = strat("trend", {});
    const { book, feed, board } = await run(cfg, flat(3));
    const agent = { ...expandGroups(parseConfig({ groups: [{ preset: "momentum", bankrollSol: 1, targets: [MINT] }] }).groups)[0]!, id: "a", strategy: cfg };
    const rules = new StrategyBrain(cfg);
    const input = { agent, book, feed, maxBuySol: 1, now: 4 * MIN, board };
    const greedy = new ClaudeBrain({ complete: async () => JSON.stringify({ action: "buy", mint: MINT, sol: 1, reason: "all in" }), fallback: rules, clamp: (i, a) => rules.clamp(i, a) });
    const a = await greedy.decide(input);
    expect(a.kind).toBe("buy");
    // 1% risk over a 12% stop is 8.3% of equity.
    expect((a as any).sol).toBeCloseTo(1 / 12, 3);
    const down = new ClaudeBrain({ complete: async () => { throw new Error("down"); }, fallback: rules });
    expect((await down.decide(input)).kind).toBe("hold");
  });

  it("warms up from past candles in another currency", async () => {
    const cfg = strat("trend", { entryBars: 5, exitBars: 3, trendBars: 0, atrBars: 5, trailAtr: 0 });
    const brain = new StrategyBrain(cfg);
    // Twelve flat one-minute candles priced around 200 (USD), while the coin trades at 1 SOL.
    const candles = Array.from({ length: 12 }, (_, i) => ({ t: i * MIN, o: 200, h: 201, l: 199, c: 200 }));
    brain.seed(MINT, candles, 1, 12 * MIN);
    const feed = new TestFeed();
    const ledger = new Ledger();
    ledger.open("a", 1);
    const agent = { id: "a", name: "a", targets: [{ mint: MINT, symbol: "T" }], strategy: cfg } as unknown as AgentSpec;
    const decide = (price: number, now: number) => {
      feed.push(price, now);
      return brain.decide({ agent, book: ledger.book("a"), feed, maxBuySol: 1, now });
    };
    expect((await decide(1.0, 13 * MIN - 1)).kind).toBe("hold");
    expect((await decide(1.05, 14 * MIN - 1)).kind).toBe("hold");
    expect((await decide(1.06, 15 * MIN - 1)).kind).toBe("buy");
  });
});

describe("backtest", () => {
  it("reads candle files in both formats", () => {
    const mexc = parseCandles("20260618 010600;0.010164;0.010164;0.010142;0.010142;4055.26\n20260618 010500;1;2;0.5;1.5;10\n");
    expect(mexc).toHaveLength(2);
    expect(mexc[0]!.t).toBe(Date.UTC(2026, 5, 18, 1, 5, 0));
    expect(mexc[1]!.c).toBe(0.010142);
    const csv = parseCandles("time,open,high,low,close,volume\n1700000000,1,2,0.5,1.5,10\n1700000060000,1.5,2,1,1.8,5\nbroken\n");
    expect(csv.map((c) => c.t)).toEqual([1_700_000_000_000, 1_700_000_060_000]);
  });

  it("replays candles through the swarm with fees and reports the result", async () => {
    const closes = [...flat(30), ...ramp(40, 1.01, 2), ...ramp(20, 1.95, 1.2)];
    const candles: Candle[] = closes.map((c, i) => ({ t: i * MIN, o: closes[i - 1] ?? c, h: Math.max(c, closes[i - 1] ?? c), l: Math.min(c, closes[i - 1] ?? c), c, v: 1 }));
    const strategy = strat("trend", { entryBars: 5, exitBars: 3, trendBars: 0, atrBars: 5, costBps: 100 });
    const r = await backtest(candles, { strategy, feeBps: 30, slippageBps: 40 });
    expect(r.candles).toBe(90);
    expect(r.sells).toBeGreaterThan(0);
    expect(r.returnPct).toBeGreaterThan(0);
    expect(r.buyHoldPct).toBeCloseTo(20, 0);
    expect(r.exposurePct).toBeGreaterThan(10);
    const free = await backtest(candles, { strategy, feeBps: 0, slippageBps: 1 });
    expect(free.returnPct).toBeGreaterThan(r.returnPct);
  });
});

describe("history", () => {
  it("picks a served candle size that fits the bar", () => {
    expect(candleSizeFor(14_400)).toMatchObject({ timeframe: "hour", aggregate: 4 });
    expect(candleSizeFor(600)).toMatchObject({ timeframe: "minute", aggregate: 5 });
    expect(candleSizeFor(30)).toMatchObject({ timeframe: "minute", aggregate: 1 });
  });

  it("reads pools and candles from GeckoTerminal's response shape", async () => {
    const urls: string[] = [];
    const fetcher = (async (url: string) => {
      urls.push(url);
      const body = url.includes("/tokens/") ? { data: [{ attributes: { address: "POOL" } }] } : { data: { attributes: { ohlcv_list: [[1700003600, 2, 3, 1, 2.5, 9], [1700000000, 1, 2, 0.5, 1.5, 10]] } } };
      return new Response(JSON.stringify(body));
    }) as unknown as typeof fetch;
    expect(await topPool(MINT, fetcher)).toBe("POOL");
    const cs = await poolCandles("POOL", { sec: 3600, limit: 50, fetcher });
    expect(cs.map((c) => c.t)).toEqual([1_700_000_000_000, 1_700_003_600_000]);
    expect(urls[1]).toContain("/pools/POOL/ohlcv/hour?aggregate=1&limit=50");
  });
});
