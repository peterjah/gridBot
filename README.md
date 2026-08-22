# Grid Bot — systematic grid market-making on Uniswap V3 (Base)

A **systematic grid / market-making strategy implemented using Uniswap V3** on
the Base network. The bot trades a configurable price grid: it buys ETH as
price moves down through grid levels, sells as price moves up, and harvests
the spread. The objective is to accumulate value in **USD/USDC** from
volatility while controlling directional exposure.

This is **not** an LP-position rebalancer. There is no "move the range when
price leaves it" logic. The core concepts are GRID, TRADES, INVENTORY,
PROFIT and USD VALUE.

```
Price data ──►  GridStrategy (pure)  ──►  actions: BUY / SELL / LIQUIDATE
                     ▲                              │
        market data adapter                         │ trading executor adapter
        ┌──────────┴───────────┐          ┌──────────┴───────────┐
   CSV history (backtest)   live pool state    SimulatedExecutor   UniswapV3Executor
        (backtester)           (paper)           (backtest)         (live swaps)
```

The strategy code is identical in all modes — only the market-data and
execution adapters change.

## Modes

| Mode | Command | Market data | Execution |
| --- | --- | --- | --- |
| `backtest` | `npm run backtest` | CSV file | simulated (fee/slippage/gas model) |
| `paper` | `npm run paper` | live Base pool price | none — decisions logged only |
| `live` | `npm run live` | live Base pool price | real swaps via SwapRouter02 |
| `optimize` | `npm run optimize` | CSV file | parameter sweep, ranked + out-of-sample |
| `walk-forward` | `npm run walk-forward` | CSV file | train → test folds |
| `compare` | `npm run compare` | saved runs | side-by-side comparison |

## How the grid works

Levels are multiplicative around a center:

```
level[i] = center * (1 + spacing)^i      i = -levelsBelow .. +levelsAbove
```

* Levels above the center rest SELL orders; below rest BUY orders.
* When price crosses a level between two observations, the order executes —
  jumps across several levels execute every crossed level in order.
* A BUY at level *i* re-arms a SELL at level *i+1*; a SELL re-arms a BUY at
  *i−1*. Oscillation around any level harvests one spacing per round trip.
* Every fill updates explicit inventory (USDC + ETH). The strategy never
  spends USDC it does not have or sells ETH it does not own.
* Inventory limits (`MIN_ETH_USD`, `MAX_ETH_USD`) stop the strategy from
  over-accumulating in crashes or selling everything in uptrends; skipped
  orders are counted and reported.

### Grid reset with volatility cooldown

Strong directional moves leave a static grid behind. When price moves
`GRID_RESET_BUFFER_LEVELS` spacings beyond the outermost level:

1. **Liquidate**: the entire ETH inventory is sold for USDC (realizing any P&L).
2. **Cooldown**: all resting orders are deactivated. The bot waits at least
   `GRID_REGEN_MIN_SECONDS` AND until realized volatility over the last
   `GRID_VOL_LOOKBACK` observations drops below `GRID_MAX_VOL_PER_STEP`.
3. **Rebuild**: a fresh grid is centered on the current price and trading
   resumes.

This is deliberately simple (no trend prediction): it bounds how much
inventory the strategy can drag through a trend and keeps it flat while the
market is violent.

### Volatility protections

Three deterministic safeguards reduce exposure to hostile markets:

1. **Volatility gate on buys** — while realized volatility (same estimator as
   the cooldown check) is above `GRID_MAX_VOL_PER_STEP`, new BUY levels are
   skipped. The strategy stops accumulating into exactly the regimes that end
   in liquidations; sells remain allowed to de-risk.
2. **Cost-aware spacing floor** — the grid refuses to start if the spacing
   cannot pay for itself: `spacing% >= 10 × (fee + slippage)`. A 1% grid needs
   total costs below 10bps per fill.
3. **Reset circuit breaker** — every `GRID_BREAKER_RESETS` resets within
   `GRID_BREAKER_WINDOW_SECONDS` doubles the required cooldown. Clustered
   liquidations signal a hostile regime; the bot waits progressively longer
   before re-entering.

## Execution approach

Grid fills are executed as **Uniswap V3 swaps** (SwapRouter02) when the
strategy detects a crossing — chosen after evaluating range-order approaches
for V1. See [docs/EXECUTION_APPROACH.md](docs/EXECUTION_APPROACH.md) for the
full analysis and the upgrade path to range orders.

## Installation

```bash
npm install
cp .env.example .env
npm run generate-data   # creates data/sample-prices.csv (deterministic)
```

Requires Node.js 20+.

## Configuration

`.env` (see `.env.example`):

```text
MODE=backtest

# Backtesting needs none of these:
RPC_URL=...            # paper/live only (comma-separated fallbacks)
PRIVATE_KEY=...        # live only
POOL_ADDRESS=0x...     # paper/live only (WETH/USDC 0.05% on Base by default)

INITIAL_USDC=10000
INITIAL_ETH=0
GRID_CENTER_PRICE=4000
GRID_SPACING_PERCENT=1
GRID_LEVELS_ABOVE=5
GRID_LEVELS_BELOW=5
ORDER_SIZE_USD=1000

SWAP_FEE_BPS=5
SLIPPAGE_BPS=3
ESTIMATED_GAS_USD=0.02

MIN_ETH_USD=0
MAX_ETH_USD=1000000000000

GRID_RESET_BUFFER_LEVELS=2
GRID_REGEN_MIN_SECONDS=21600
GRID_VOL_LOOKBACK=24
GRID_MAX_VOL_PER_STEP=0.005

CSV_FILE=data/sample-prices.csv
REPORT_FILE=reports/backtest.html
POLL_INTERVAL_SECONDS=30
LIVE_CONFIRM=            # must be "yes" to start live mode
```

### Backtesting

```bash
npm run backtest -- --spacing 1 --levels-above 5 --levels-below 5 --capital 10000
```

Other flags: `--center`, `--eth`, `--order-size`, `--fee-bps`,
`--slippage-bps`, `--gas`, `--min-eth-usd`, `--max-eth-usd`,
`--reset-buffer`, `--regen-min-seconds`, `--vol-lookback`, `--max-vol`,
`--csv`, `--report`.

Replay a specific configuration — e.g. a row copied out of the optimizer
table — with `--config`:

```bash
npm run backtest -- --config "spacing=1,width=20,reset=3,order=2"
npm run backtest -- --config my-config.json
```

`width` is the grid half-width in percent (converted to a level count at the
chosen spacing) and `order` is the per-level allocation as a percent of
capital. A JSON file may set any `GridConfig` field directly.

Backtests are fully deterministic: same data + parameters ⇒ identical results.
The console report shows the P&L decomposition, a block per reset, the reset
summary, inventory analytics, the grid-center evolution and benchmarks. An
HTML chart report (price + grid center + reset points, portfolio value vs
benchmarks on one shared axis, ETH inventory) is written to
`reports/backtest.html`, and CSV exports land in `results/`:

| File | Contents |
| --- | --- |
| `results/trades.csv` | every fill: balances, fees, gas, grid vs reset P&L, reset id |
| `results/resets.csv` | every reset: inventory, cost basis, P&L, bounds, drawdown |
| `results/equity.csv` | the equity/inventory curve |
| `results/optimization.csv` | one row per swept configuration (optimize mode) |

### Where the money comes from

The backtest never reports a single blended "profit". Three sources are
tracked separately at the point of the fill:

| Source | Meaning |
| --- | --- |
| **A · Grid trading P&L** | profit from completed buy → sell cycles |
| **B · Reset / inventory P&L** | profit or loss on ETH liquidated at a reset |
| **C · Trading costs** | swap fees, slippage, gas — never folded into A or B |

plus unrealized P&L on whatever inventory is still open. The reset is a
**risk-management mechanism that liquidates accumulated inventory**, so its
cost belongs in B, separately from what the grid earned in A. A strategy whose
A is positive only because B keeps absorbing large losses is not profitable,
and the reports are built to make that visible.

Every run reconciles:

```
portfolio value = initial capital + A + B + unrealized − fees − slippage − gas
```

`assertAccountingReconciles` throws if the residual drifts, so an unbalanced
run can never reach the optimizer. See [docs/ACCOUNTING.md](docs/ACCOUNTING.md).

### Reset analytics

Each reset produces a full record: the price and reason that triggered it, the
grid bounds before and after, the ETH inventory and its average acquisition
price, the USDC recovered, the inventory P&L against that cost basis, the grid
P&L / fees / slippage / gas accrued since the previous reset, portfolio value
either side, and the drawdown at the moment it fired.

Reset reasons are `PRICE_OUTSIDE_GRID` (the only one the strategy produces
today), `INVENTORY_LIMIT` and `MANUAL`; the data model is extensible so new
triggers need no reporting changes.

### Parameter optimization

```bash
npm run optimize
npm run optimize -- --metric risk_adjusted --top 20
npm run optimize -- --spacings 0.5,1,2 --widths 10,20 --reset-buffers 2,3 --order-fractions 2,5
```

The sweep crosses grid spacing × grid width × reset buffer × order allocation,
skipping combinations that are impossible up front (more capital required than
available, or a spacing that cannot pay its own fees) and reporting how many
were skipped and why. For each configuration it records final value, return,
max drawdown, grid P&L, reset P&L, fees, slippage, gas, trades, resets,
average and worst reset loss, ETH exposure, and the USDC / ETH-hold / static-LP
comparisons.

Ranking metric is configurable — `RETURN` (the default, same ordering as final
portfolio value), `RISK_ADJUSTED` (`return / |maxDrawdown|`, safe at zero
drawdown), `DRAWDOWN`, `GRID_PNL` — via `--metric` or `OPTIMIZER_METRIC`.

Every optimize run also prints a **market-regime breakdown** of the winning
configuration (full period, then per calendar year, or per quarter for a
single-year dataset) with the realized volatility and a bull/bear/sideways
label per period, and an **out-of-sample check**: parameters selected on the
first 60% of the data, then run untouched on the remaining 40%.

### Saving and comparing experiments

Every run is archived under a label, so a sequence of parameter experiments
accumulates instead of overwriting itself:

```bash
npm run optimize -- --label baseline
npm run optimize -- --label vol-open --max-vols 0.005,0.01,0.02,0.05
npm run optimize -- --label with-caps --max-vols 0.02 --inventory-caps 0,10,20,40
npm run compare
```

Artifacts land in `results/<label>/` (`optimization.csv` for sweeps;
`report.html`, `trades.csv`, `resets.csv`, `equity.csv` for backtests) plus a
`run.json` summary. `npm run compare` lines every saved run up by return, with
its grid P&L, reset P&L, costs, exposure and out-of-sample decay, writes
`results/comparison.csv`, and prints a ready-to-paste `--config` command to
replay any of them. It flags when the runs span different datasets, because
returns from different price paths are not comparable.

### Real data

`npm run fetch-data` pulls real hourly history from Binance's public API (no
key required) into the CSV format the backtester reads:

```bash
npm run fetch-data                                    # ETHUSDT 1h since 2021
npm run fetch-data -- --symbol BTCUSDT --from 2023-01-01 --out data/btc.csv
npm run backtest -- --csv data/eth-1h.csv
```

### LP fee income (optional model)

The bot as implemented **swaps** via SwapRouter02 — it is a taker and *pays*
fees. Enabling this model instead treats the grid's resting orders as
concentrated liquidity that *earns* a pro-rata share of pool fees while in
range:

```
poolVolume = referenceVolumeUsd × LP_VENUE_VOLUME_SHARE_PCT/100
myShare    = myValueInRange / (myValueInRange + LP_POOL_LIQUIDITY_USD)
income     = poolVolume × LP_FEE_BPS/10000 × myShare
```

The pro-rata term matters: without it, fee income would not scale with the
capital deployed and a $1k position would earn what a $1M one does. Income
accrues only while the grid is ACTIVE *and* price is inside its band. Disabled
by default (`LP_POOL_LIQUIDITY_USD=0`). Needs a CSV with a `volume` column —
`npm run fetch-data` provides one.

```bash
npm run backtest -- --csv data/eth-1h.csv \
  --lp-venue-share 1 --lp-pool-liquidity 15000000
```

**Measured result on real ETH (2021-2026, $10k):** with a middle calibration
(1% of Binance volume routed through the pool, $15M competing TVL, 5bps),
the best of 176 configurations returns **+127.9%** over 5.6 years with a
−1.1% max drawdown, profitable in every calendar year including 2022's −68%
crash — but still **110 points behind ETH buy-and-hold**. Critically, the
trading is *net negative* (grid P&L +$287, reset P&L −$557): **LP fee income
supplies all of the profit.** The result is therefore a function of the
assumed pool economics, not of the strategy. Sweeping that assumption moves
the answer from **+2% to +12,318%** — see the sensitivity table in
`docs/LP_MODEL.md` before trusting any single number.

### Causal regime filter

`REGIME_MAX_MOVE_PCT` pauses the grid when the trailing move over
`REGIME_LOOKBACK_POINTS` observations exceeds a threshold — "stand aside
during big moves". It is deliberately **causal**: it looks only at past
observations, because selecting calm periods with hindsight is lookahead bias
and invents returns that cannot be captured live.

**Measured result: the filter costs money under the LP fee model.** Returns
fall monotonically as the filter tightens (+127.9% always-on → +105.6% at a
30% threshold → +34.3% at 10%), because fee income is paid for *presence* and
pausing removes it. Max drawdown improves (−1.1% → −0.35%), but it was
already negligible. Default is off.

### Scenario optimization

Optimizing on one stretch of history fits one stretch of history. Scenario
mode instead selects **every** window matching a market profile and ranks
configurations on their **median across windows**:

```bash
# every 12-month window where ETH rose 10-60%
npm run scenario -- --csv data/eth-1h.csv --move-min 10 --move-max 60
# sideways markets instead
npm run scenario -- --csv data/eth-1h.csv --move-min -10 --move-max 10
```

Output reports median / mean / worst / best return across windows, the share
of windows that were profitable, and — the column that matters — the share
where the grid beat simply holding the asset. Per-window results are written
to `results/<label>/scenario.csv`.

**Measured result on real ETH (2021-2026):** across the 10 historical
12-month moderate-uptrend windows, the best of 232 configurations returned a
median of **+1.82%** and was profitable in 90% of windows — but beat ETH
buy-and-hold in **0 of 10** windows, trailing it by a median of 34 percentage
points. Not one of 232 configurations beat ETH in even a single window. In
sideways windows the grid beats ETH ~67% of the time, but its own median
return is still negative: it loses less, it does not win.

### Reset liquidation policy

By default a reset sells the **entire** ETH inventory — the original,
unconditional behavior. Two settings relax that, both defaulting to the
original policy:

| Setting | Default | Effect |
| --- | --- | --- |
| `RESET_SELL_FRACTION` | `1` | fraction of inventory sold at a reset |
| `RESET_UNDERWATER_SKIP_PCT` | `0` (off) | carry the inventory instead of selling when it is underwater by more than this % |

Both are sweepable (`--sell-fractions`, `--underwater-skips`), and every reset
record reports `ethLiquidated`, `ethCarried` and a `carryReason`
(`NONE` / `PARTIAL_POLICY` / `UNDERWATER`).

**Measured result: carrying inventory does not help — it relabels the loss.**
Across a 936-configuration sweep on the bear dataset, median return degrades
monotonically as more inventory is carried (−18.4% → −24.6% → −29.3% → −36.4%
at sell fractions 100/50/25/0%), while median ETH exposure climbs 28% → 74%.
The reset P&L shrinks to zero exactly as the grid P&L goes negative: the
carried inventory is still sold, just later and lower, by the next grid's SELL
levels. On the uptrend dataset carrying helps slightly (+6.12% vs +5.52% at a
50% sell fraction) — a mean-reversion bet that pays in a bull market and costs
far more in a bear one. Hence the default stays at a full dump.

### Risk axes

Beyond grid geometry, the sweep can vary the three settings that govern how
much inventory is accumulated before a reset dumps it:

```bash
npm run optimize -- \
  --max-vols 0.005,0.02 \        # volatility gate on buys
  --inventory-caps 0,20,40 \     # ETH ceiling, % of capital (0 = uncapped)
  --cooldown-hours 6,24,72        # wait before rebuilding
```

Left unset, each inherits the base configuration and the sweep is exactly the
four-axis product from spec section 9. Columns appear in the ranked table only
for the axes actually being swept.

### Out-of-sample validation

```bash
npm run walk-forward
npm run walk-forward -- --folds 4 --train-fraction 0.5
```

Expanding-window folds: train on everything up to a cut, test on the next
chunk, repeat. The summary reports how many folds were profitable out of
sample, the average out-of-sample return, and whether the winning parameters
were stable across folds or drifted — the difference between a robust
configuration and a lucky one.

### Benchmarks & honest accounting

Every backtest reports against passive alternatives:

* **USDC only** — did the strategy beat holding cash?
* **ETH buy & hold** — the classic trap: strategies can look profitable while
  underperforming simply holding the asset.
* **Static V3 LP (no fees)** — quantifies divergence loss / impermanent loss
  explicitly rather than claiming it away.

The question the backtest answers: *did the grid create more USD value than
the passive alternatives, after fees, slippage and gas?*

### Paper trading

```bash
MODE=paper POOL_ADDRESS=0xd0b53D9277642d899DF5C87A3966A349A798F224 RPC_URL=https://mainnet.base.org npm run paper
```

Runs the strategy against the live pool price every poll interval and logs
decisions and portfolio state. No transactions are ever sent.

### Live trading

⚠️ Experimental. Only start here after backtests and paper trading look good,
with a small amount of capital in a dedicated hot wallet:

```bash
MODE=live LIVE_CONFIRM=yes PRIVATE_KEY=0x... \
POOL_ADDRESS=0xd0b53D9277642d899DF5C87A3966A349A798F224 \
RPC_URL=https://mainnet.base.org npm run live
```

Each fill is quoted via QuoterV2 with an on-chain slippage floor, simulated
before signing, and its receipt verified. Refuses to start without
`LIVE_CONFIRM=yes`.

## Development

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest — grid logic, cost model, resets, determinism
npm run generate-data
```

Strategy tests cover single/multi-level crossings up and down, oscillation
profitability, inventory limits in trends and crashes, fee/slippage
accounting, grid reset/cooldown behavior and full determinism.

## Security notes

* Backtesting never requires or reads private keys.
* Live mode sends real transactions — use a dedicated wallet with limited funds.
* Swaps carry slippage protection (`amountOutMinimum` from QuoterV2 quotes).
* No MEV protection, no multi-pool routing — deliberate non-goals for V1.

MIT
