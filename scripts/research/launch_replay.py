"""Replays exit rules over fresh pump.fun launches, to check the flow style's settings.

Data: https://github.com/ian05012/solana-memecoin-dataset (MIT), June 2026.
Each token is entered once, at the open of the first 15-minute candle after it
was first detected, and managed on 15-minute candles. Inside a candle, stops
are assumed to fill before targets.

    pip install pandas pyarrow duckdb numpy
    python scripts/research/launch_replay.py path/to/solana-memecoin-dataset/data
"""
import sys

import duckdb
import numpy as np
import pandas as pd

D = sys.argv[1] if len(sys.argv) > 1 else "data"
con = duckdb.connect()
t = pd.read_parquet(f"{D}/tokens.parquet")
t["cap"] = pd.to_datetime(t.captured_at, utc=True)
t = t.sort_values("cap")

# Buy pressure in the 120 seconds before detection, from wallet-level trades.
con.register("snap", t[["sample_id", "token_address", "cap"]])
flow = con.sql(f"""
  select s.sample_id,
    count(distinct case when side = 'buy' then wallet end) buyers120,
    sum(case when side = 'buy' then amount_usd else -amount_usd end) net120
  from snap s join '{D}/trades-*.parquet' tr
    on tr.token_address = s.token_address and tr.ts <= s.cap and tr.ts >= s.cap - interval 120 second
  group by 1""").df()
t = t.merge(flow, on="sample_id", how="left").fillna({"buyers120": 0, "net120": 0})

o = pd.read_parquet(f"{D}/ohlcv.parquet")
o = o[(o.high <= o.close * 10) & (o.close > 0)].sort_values(["token_address", "ts"])  # drop glitch candles
candles = {k: g[["ts", "open", "high", "low", "close"]].to_numpy() for k, g in o.groupby("token_address")}


def path(row):
    c = candles.get(row.token_address)
    if c is None:
        return None
    nxt = c[c[:, 0] >= row.cap.timestamp()]
    return nxt if len(nxt) >= 2 and nxt[0, 0] - row.cap.timestamp() <= 900 else None


def trade(c, stop=0.15, trail=0.20, tp1=0.30, f1=0.4, tp2=0.75, f2=0.5, hold=4, cost=0.03):
    """Net return of one position entered at the first candle's open."""
    entry, left, got, peak, rung = c[0, 1], 1.0, 0.0, c[0, 1], 0
    for _, op, hi, lo, _cl in c[:hold]:
        level = max(entry * (1 - stop), peak * (1 - trail) if trail > 0 else 0)
        if op <= level or lo <= level:
            got += left * min(op, level)
            left = 0
            break
        if rung == 0 and hi >= entry * (1 + tp1):
            got, left, rung = got + left * f1 * entry * (1 + tp1), left * (1 - f1), 1
        if rung == 1 and hi >= entry * (1 + tp2):
            got, left, rung = got + left * f2 * entry * (1 + tp2), left * (1 - f2), 2
        peak = max(peak, hi)
    if left > 0:
        got += left * c[min(hold, len(c)) - 1, 4]
    return got / entry * (1 - cost) - 1


first = t[[path(r) is not None for r in t.itertuples()]].drop_duplicates("token_address").reset_index(drop=True)
cut = int(len(first) * 0.6)
halves = {"first 60% by date": first.iloc[:cut], "last 40% by date": first.iloc[cut:], "all": first}
rng = np.random.default_rng(1)


def report(name, df, **kw):
    x = np.array([trade(path(r), **kw) for r in df.itertuples()])
    boot = [rng.choice(x, len(x)).mean() for _ in range(400)]
    print(f"  {name:46} n {len(x):5}  mean {x.mean() * 100:6.1f}% [{np.percentile(boot, 2.5) * 100:5.1f}, {np.percentile(boot, 97.5) * 100:5.1f}]  median {np.median(x) * 100:6.1f}%  wins {(x > 0).mean() * 100:4.1f}%")


groups = {
    "every launch": lambda d: d.index == d.index,
    "buy pressure: 15+ buyers, $1,500+ net in 120s": lambda d: (d.buyers120 >= 15) & (d.net120 >= 1500),
    "small: market cap under $13k": lambda d: d.market_cap_usd < 13000,
    "larger: cap $28k+ and liquidity $13k+": lambda d: (d.market_cap_usd >= 28000) & (d.liquidity_usd >= 13000),
    "larger, and net selling in the last 120s": lambda d: (d.market_cap_usd >= 28000) & (d.liquidity_usd >= 13000) & (d.net120 < 0),
}
print(f"{len(first)} launches, median age {first.time_since_launch_sec.median() / 60:.0f} min, median market cap ${first.market_cap_usd.median():,.0f}, median liquidity ${first.liquidity_usd.median():,.0f}")
for half, df in halves.items():
    print(f"\n{half}: flow defaults (stop 15%, trail 20%, targets +30%/+75%), 1 hour, 3% round trip")
    for name, f in groups.items():
        report(name, df[f(df)])
big = first[groups["larger: cap $28k+ and liquidity $13k+"](first)]
print("\nlarger launches, all dates, by round-trip cost (stop 25%, trail 30%, 6 hours)")
for cost in (0.01, 0.03, 0.06, 0.10):
    report(f"cost {cost * 100:.0f}%", big, stop=0.25, trail=0.30, hold=24, cost=cost)
print("\nevery launch, all dates, holding with no stops or targets")
for hold, label in ((1, "15 minutes"), (4, "1 hour"), (24, "6 hours"), (96, "24 hours")):
    report(label, first, stop=0.999, trail=0, tp1=1e9, tp2=1e9, hold=hold)
