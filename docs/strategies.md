# Trading styles: what they do, why, and how they tested

Agents trade one of four styles. Each is a short list of rules with numbers you can tune per group. This page gives the rules, the evidence behind each default, and the results of replaying them over real memecoin prices.

**Read this first.** None of these styles is a money machine, and the tests below say so. In the month tested, the median memecoin fell 25% and no long-only style made money; what the styles did was lose about 1% instead. Over three years the median coin fell 84%. The honest claim is that these rules keep an agent out of most of the damage and trade rarely enough that costs do not eat it, not that they produce profit. Paper trade your own targets before going live.

## The four styles

| Style | Buys when | Sells when | Default bar | Needs |
|---|---|---|---|---|
| `trend` | A bar closes above the 20-bar high and price is above its 50-bar average | A bar closes below the 10-bar low, price falls 3 ATR from its high, or the stop is hit | 4 hours | Prices |
| `reversion` | Price is 2 standard deviations under its 20-bar average, the 20-bar average is above the 200-bar one, and the distance back to the average is at least 2.5 times the round-trip cost | Price is back within 0.5 standard deviations, 30 bars pass, or the stop is hit | 5 minutes | Prices |
| `flow` | A `buy_pressure` signal is active, price is up over 3 bars, it has not already run 40% in 15 bars, and the coin moves enough to pay costs | 40% of the position at +30%, half the rest at +75%, the rest 20% off the high, after 15 bars, or on any sell signal | 1 minute | The on-chain stream |
| `accumulate` | Every 6 bars while price is above its 60-bar average, 5% of equity each time, up to 30% in one coin | A bar closes 5% under that average, or the stop is hit | 4 hours | Prices |

Presets pick a style when a group names none: `momentum` and `showman` trade `trend`, `contrarian` trades `reversion`, `sniper` and `degen` trade `flow`, `holder` trades `accumulate`. The preset's risk trait picks the profile: `cautious` halves the size settings, `aggressive` doubles them, and neither changes the signals.

`pnpm start -- --strategies` prints every setting with its default and allowed range.

## The shared risk layer

Every style sizes and protects itself the same way.

- **Size.** A buy is sized so that hitting the stop loses `riskPct` of equity (1% by default): size = equity x riskPct / stop distance, capped at `maxPositionPct` of equity in one coin. This is the Turtle rule [T1] and sits near quarter-Kelly for a strategy with an unmeasured edge [S1].
- **Stops.** A hard stop at `stopPct`, plus a trailing stop where the style uses one. Stops tighter than about 10% gave no benefit after costs in the studies we found [S3][S4], so the defaults are 12% to 25%, and a trend stop is never set closer than two round trips of cost (three for its trailing stop).
- **Cost gate.** `costBps` is the round trip you expect to pay. Entries that cannot plausibly beat it are skipped. Set it honestly: about 100 to 270 for a deep pool, 330 to 660 for a mid-liquidity memecoin, 700 or more on a bonding curve [C1][C2][C3].
- **Smallest order.** Buys under `minOrderSol` (0.01 SOL) are skipped, because priority fees are a fixed cost. With a bankroll under about 1 SOL at 1% risk, most setups will be skipped for this reason. Raise `riskPct` or the bankroll rather than lowering the minimum.
- **Circuit breakers.** Three losing sells in a row pause new buys (`maxLossStreak`, `pauseBars`), and a 5% loss on the day stops buying until the next UTC day (`dailyLossPct`). These two are convention, not evidence: we found no study supporting either number.
- **Swarm signals still win.** A whale sell, a large holder moving tokens or heavy sell pressure sells the position, whatever the style.

With `"brain": "claude"` the model chooses among setups with the style in its prompt, its buy size is capped by the style's size rule, and the style's rules take over whenever the model fails.

## Evidence for each style

### trend

- Past returns persist for 1 to 12 months across 58 futures markets [T2], and over a century of data [T3].
- In crypto, a one-standard-deviation week in Bitcoin predicts +3.2% to +3.7% over the next one to three weeks [T4]. One-to-four-week momentum earns 2.5% to 4.1% a week long-short, but 4.2% in above-median coins against an insignificant 0.6% in small ones [T5].
- Of 14,919 technical rules tested on crypto, channel breakouts did best and survived data-snooping tests, with break-even costs of only 8 to 148 basis points one way [T6].
- A stop-loss cut momentum's worst month from -49.8% to -15.4% in equities [S5].

What that supports: breakout entry, channel exit, a trend filter, long holds and few trades. What it does not support: any of this at bars under a day, or in tokens too small to trade cheaply. The 20/10 channel and 2 ATR stop are the Turtle numbers [T1]. The 4-hour bar is our choice from the test below, where shorter bars lost steadily more.

### reversion

- Last period's losers beat last period's winners at weekly and monthly horizons in equities [R1][R2], and about 40% of the measured return is bid-ask bounce that cannot be captured [R3].
- In crypto the effect lives in illiquid pairs: 1.23% a day gross in low-volume pairs against 0.54% in high-volume ones, falling to 0.73% and 0.04% net of 20 to 40 basis points [R4]. Across 3,600 coins reversal is driven by illiquidity, while the largest coins show momentum instead [R5].
- Entry at 1.25 standard deviations and exit at 0.5 comes from a study that paid 10 basis points a round trip [R6]. We enter at 2 because our costs are ten times that.
- Dip-buying rules only worked above the long moving average [R7], and the standard 20-period, 2-deviation band is a starting point rather than a signal [R8].

The liquidity paradox is the main fact here: the edge exists where costs are highest. The cost gate (`edgeX`) is our answer and its 2.5 is a judgment call. Most pump.fun tokens have no stable mean to revert to, so do not point this style at them.

### flow

- Price moves in proportion to signed order flow, scaled by depth [F1][F2]. Buying imbalances persist because large traders split orders, then reverse [F3].
- In 3,200 crypto pump events only buyers in the first 20 to 30 seconds profited on average, and most of the effect was gone within the hour [F4]. That is why this style takes profit early and has a 15-minute time stop.
- The base rates are hostile. 0.63% of 655,770 pump.fun tokens graduated, and 92% of tokens with at least 30 swaps had a dump [F5]. 98.6% of pump.fun tokens fell under $1,000 of liquidity [F6]. 73% of graduated launches fell below 40% of their migration price within 20 minutes [F7].
- Concentration and fake demand predict collapse: bundled wallets held 36.5% of supply at migration and 21.4% of pre-migration transactions were wash trades [F7].

The `buy_pressure` signal this style follows is tuned under `signals` in the config. The research suggests asking for more than the current defaults before trusting it: about 15 distinct buyers and 10 SOL net in 120 seconds, on a coin with at least 100 holders and 50 SOL in the pool. Those numbers are judgment informed by [F5][F7], and the holder and pool checks are not built yet. Every flow threshold on this page is untested against real wallet data.

### accumulate

- Buying on a schedule is risk control, not a source of return: a lump sum beat it 68% of the time [A1], and theory agrees [A2].
- What cuts drawdowns is the trend filter. Holding the S&P 500 only above its 10-month average since 1901 cut the worst drawdown from -83.5% to -50% [A3].
- Cutting exposure when volatility is high improved risk-adjusted returns across asset classes [A4].

The schedule, slice size and average length are judgment calls. Nothing has been published on this at memecoin timescales.

## What the styles must never do

The swarm coordinates to manage risk only. It does not stage buys across wallets to look like demand, trade between its own wallets, or run volume bots, and the flow style ignores the swarm's own wallets when reading buy pressure. Those practices are market manipulation (in the US, wash trading and manipulation under the Commodity Exchange Act and wire fraud statutes; in the EU, MiCA Article 91), and the Department of Justice charged 18 people and firms over exactly this in October 2024 [L1].

## Backtest

`scripts/backtest.ts` replays candles through the same swarm, guard rails and paper fills a paper run uses.

**Data.** MEXC spot candles against USDT for memecoins, from the public dataset [KrazySnipeOof/MEXC-data](https://github.com/KrazySnipeOof/MEXC-data) at commit `759c3a9`: 1-minute candles for 20 May to 19 June 2026 (322 coins with at least 30,000 candles) and daily candles for up to three years (151 coins with at least 500). The data is not in this repo. We split the 322 coins in two, chose bar lengths on one half and report the other half here.

**Costs.** "Liquid" is a 0.3% fee and 0.2% slippage per side, about 1% a round trip. "Thin" is the config's default 1% fee and 1.5% slippage per side, about 5% a round trip.

### One month of 1-minute candles, 161 held-out coins, default settings

The median coin fell 24.9% over the month and the average fell 22.1%.

| Style | Costs | Mean return | Median return | Mean max drawdown | Worst coin | Sells | Winning sells |
|---|---|---|---|---|---|---|---|
| trend | liquid | -0.5% | -0.7% | 1.9% | -4.9% | 265 | 22% |
| trend | thin | -0.9% | -0.9% | 1.8% | -5.1% | 246 | 13% |
| reversion | liquid | -0.4% | -0.1% | 1.0% | -6.0% | 1,804 | 48% |
| reversion | thin | -0.1% | 0.0% | 0.2% | -6.8% | 62 | 27% |
| accumulate | liquid | -1.6% | -1.8% | 4.6% | -10.5% | 189 | 2% |
| accumulate | thin | -2.4% | -2.4% | 4.9% | -10.8% | 189 | 2% |
| flow (volume proxy) | liquid | -2.6% | -1.0% | 2.9% | -35.4% | 5,051 | 22% |
| flow (volume proxy) | thin | -0.4% | 0.0% | 0.5% | -11.7% | 131 | 17% |

Every style lost less than holding in about 88% of coins. None was profitable on average.

### Bar length matters more than anything else

Same month, the other 161 coins, liquid costs, trend with only the bar length changed:

| Bar | Mean return | Sells | Winning sells |
|---|---|---|---|
| 5 minutes | -20.2% | 14,410 | 15% |
| 15 minutes | -8.6% | 5,136 | 17% |
| 1 hour | -2.6% | 1,227 | 19% |
| 4 hours | -0.6% | 239 | 21% |

Short bars trade constantly and pay costs on noise, which is what the literature predicts [T6]. Accumulate showed the same pattern (-12.5% at 15 minutes, -6.0% at 1 hour, -1.3% at 4 hours). This is why both default to 4-hour bars.

### Three years of daily candles, 151 coins, daily bars

Holding returned -12.8% on average and -84.0% at the median: a few coins rose enormously and most collapsed.

| Style | Costs | Mean return | Median return | Profitable coins | Mean max drawdown | Worst coin |
|---|---|---|---|---|---|---|
| trend | liquid | +4.3% | -0.3% | 49% | 8.3% | -12.6% |
| trend | thin | -0.1% | -4.1% | 32% | 10.0% | -15.2% |
| accumulate (30-day average, daily buys) | liquid | +102.8% | -15.3% | 29% | 46.1% | -60.5% |
| accumulate (30-day average, daily buys) | thin | +59.8% | -26.7% | 21% | 51.5% | -66.8% |

Trend roughly kept its capital while the median coin lost 84%. Accumulate's large average comes from a handful of coins that went up many times over; its median is a loss and its drawdowns are deep. Treat it as the high-variance style.

### Limits of these tests

- **Not Solana DEX data.** These are centralized-exchange prices in USDT. On-chain pools have wider costs, worse fills on size and failed transactions. No pump.fun-size token is in the sample.
- **Survivorship.** The dataset holds coins still listed when it was built. Dead coins are missing, which flatters every result, buy and hold most of all.
- **One month.** The 1-minute sample is a single falling month. It says little about how the styles behave in a rising one.
- **Flow is not tested.** Candles carry no wallets, so the backtest stands in a volume spike on an up candle for buy pressure. That proxy is not the real signal and its row above should be read as a check that the cost gate and exits work, nothing more.
- **Fills are idealised.** Paper fills happen at the candle's close with fixed slippage. Stops are checked once per candle, so a gap through a stop is filled at the close.
- **Bar length was chosen on this data.** We picked it on one half of the coins and report the other half, but both halves are the same month.

### Run it yourself

```sh
pnpm fetch-ohlcv -- <mint> --sec 60 --pages 20 --out candles.csv   # GeckoTerminal, USD
pnpm backtest -- candles.csv --fee 30 --slip 40
pnpm backtest -- candles.csv --strategy trend --set barSec=3600,entryBars=30
pnpm backtest -- some-folder/ --strategy reversion --profile cautious --json
```

Files hold one candle per line: time, open, high, low, close, volume, split by commas or semicolons. `fetch-ohlcv` and the startup warm-up read GeckoTerminal's public API; that code is tested against the documented response shape but was not run against the live API from the environment this was built in.

## References

Sources marked (summary) were read through a secondary summary, not the paper itself.

**Trend**
- [T1] Faith, The Original Turtle Trading Rules. https://turtletradersystem.blogspot.com/2009/01/original-turtle-trading-rules-chapter-3.html
- [T2] Moskowitz, Ooi, Pedersen (2012), Time Series Momentum, Journal of Financial Economics 104(2). https://papers.ssrn.com/abstract=2089463
- [T3] Hurst, Ooi, Pedersen (2017), A Century of Evidence on Trend-Following Investing, Journal of Portfolio Management. https://www.aqr.com/insights/research/journal-article/a-century-of-evidence-on-trend-following-investing
- [T4] Liu, Tsyvinski (2021), Risks and Returns of Cryptocurrency, Review of Financial Studies 34(6). https://www.nber.org/papers/w24877
- [T5] Liu, Tsyvinski, Wu (2022), Common Risk Factors in Cryptocurrency, Journal of Finance 77(2). https://www.nber.org/papers/w25882
- [T6] Hudson, Urquhart (2021), Technical trading and cryptocurrencies, Annals of Operations Research 297. https://link.springer.com/article/10.1007/s10479-019-03357-1

**Reversion**
- [R1] Jegadeesh (1990), Evidence of Predictable Behavior of Security Returns, Journal of Finance 45(3). https://econpapers.repec.org/RePEc:bla:jfinan:v:45:y:1990:i:3:p:881-98
- [R2] Lehmann (1990), Fads, Martingales, and Market Efficiency, Quarterly Journal of Economics 105(1). https://www.nber.org/papers/w2533
- [R3] Nagel (2012), Evaporating Liquidity, Review of Financial Studies 25(7). https://www.nber.org/papers/w17653
- [R4] Bianchi, Babiak, Dickerson (2022), Trading volume and liquidity provision in cryptocurrency markets, Journal of Banking and Finance 142. https://www.riksbank.se/globalassets/media/rapporter/working-papers/2022/no.-413-trading-volume-and-liquidity-provision-in-cryptocurreny-markets.pdf
- [R5] Zaremba, Bilgin, Long, Mercik, Szczygielski (2021), Up or down? Short-term reversal, momentum, and liquidity effects in cryptocurrency markets, International Review of Financial Analysis 78 (abstract only). https://ideas.repec.org/a/eee/finana/v78y2021ics1057521921002349.html
- [R6] Avellaneda, Lee (2010), Statistical Arbitrage in the US Equities Market, Quantitative Finance 10(7). https://www.math.nyu.edu/faculty/avellane/AvellanedaLeeStatArb20090616.pdf
- [R7] Connors RSI(2), via StockCharts ChartSchool (summary). https://chartschool.stockcharts.com/table-of-contents/trading-strategies-and-models/trading-strategies/rsi-2
- [R8] Bollinger, Bollinger Band Rules. https://www.bollingerbands.com/bollinger-band-rules

**Flow**
- [F1] Kyle (1985), Continuous Auctions and Insider Trading, Econometrica 53(6). https://www.econometricsociety.org/publications/econometrica/1985/11/01/continuous-auctions-and-insider-trading
- [F2] Cont, Kukanov, Stoikov (2014), The Price Impact of Order Book Events. https://arxiv.org/abs/1011.6402
- [F3] Chordia, Subrahmanyam (2004), Order imbalance and individual stock returns (abstract only). https://escholarship.org/uc/item/34k8f3pv
- [F4] Li, Shin, Wang (2025), Cryptocurrency Pump-and-Dump Schemes, Journal of Financial and Quantitative Analysis. https://jfqa.org/wp-content/uploads/2025/01/24639_Cryptocurrency-Pump-and-Dump.pdf
- [F5] Marino, Naviglio, Tarantelli, Lillo (2026), Predicting the success of new crypto-tokens: the Pump.fun case. https://arxiv.org/abs/2602.14860
- [F6] Solidus Labs (2025), Solana rug pulls and pump-and-dumps report. https://www.soliduslabs.com/reports/solana-rug-pulls-pump-dumps-crypto-compliance
- [F7] MELT study of 41,470 graduated pump.fun launches (2026). https://arxiv.org/abs/2602.13480

**Accumulate**
- [A1] Vanguard (2023), Cost averaging: invest now or temporarily hold your cash? https://corporate.vanguard.com/content/dam/corp/research/pdf/cost_averaging_invest_now_or_temporarily_hold_your_cash.pdf
- [A2] Constantinides (1979), A Note on the Suboptimality of Dollar-Cost Averaging as an Investment Policy, Journal of Financial and Quantitative Analysis 14(2) (citation only, text not read). https://ideas.repec.org/a/cup/jfinqa/v14y1979i02p443-450_00.html
- [A3] Faber (2007), A Quantitative Approach to Tactical Asset Allocation (summary). https://www.cxoadvisory.com/technical-trading/long-term-outperformance-from-trends-defined-by-moving-averages
- [A4] Moreira, Muir (2017), Volatility-Managed Portfolios, Journal of Finance 72(4). https://www.nber.org/papers/w22208

**Sizing, stops and costs**
- [S1] MacLean, Thorp, Ziemba, Good and bad properties of the Kelly criterion. https://www.stat.berkeley.edu/~aldous/157/Papers/Good_Bad_Kelly.pdf
- [S2] Kaminski, Lo (2014), When Do Stop-Loss Rules Stop Losses?, Journal of Financial Markets. https://dspace.mit.edu/bitstream/handle/1721.1/114876/Lo_When%20Do%20Stop-Loss.pdf
- [S3] Dai et al., Using trailing stop-loss rules to reduce risk. https://acfr.aut.ac.nz/research/using-trailing-stop-loss-rules-to-reduce-risk
- [S4] Lo, Remorov (2017), Stop-loss strategies with serial correlation, regime switching, and transaction costs (summary). https://www.cxoadvisory.com/equity-premium/stop-losses-on-stock-positions-in-depth
- [S5] Han, Zhou, Zhu (2016), Taming Momentum Crashes: A Simple Stop-Loss Strategy (summary). https://www.cxoadvisory.com/technical-trading/stop-losses-to-avoid-stock-momentum-crashes/
- [C1] Raydium fee comparison. https://docs.raydium.io/reference/fee-comparison
- [C2] Pump.fun help centre, Transaction fees on pump.fun. https://intercom.help/pumpfun-web/en/articles/11002413-transaction-fees-on-pump-fun
- [C3] Jupiter Ultra fees. https://developers.jup.ag/docs/ultra/fees
- [L1] US Department of Justice, 9 October 2024, Eighteen individuals and entities charged in international operation targeting widespread fraud and manipulation in the cryptocurrency markets. https://www.justice.gov/usao-ma/pr/eighteen-individuals-and-entities-charged-international-operation-targeting-widespread
