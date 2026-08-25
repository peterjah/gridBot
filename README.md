# Grid Bot — grid market-making on Uniswap V3 (Base)

Two ways to run the same idea — buy as price falls, sell as price rises — on
Base, plus the backtesting and parameter-optimization tooling used to choose
between them.

**`lp-live` — LP re-centring (recommended).** One concentrated Uniswap V3
position is held around spot. The pool itself does the buying and selling: as
price falls through the range your USDC is converted into ETH, as it rises it
is converted back, at no fee and no gas. You earn a pro-rata share of the pool
fee that swappers pay. When price drifts past the configured trigger, the
position is closed, fees collected, tokens rebalanced and a fresh position
minted at the new centre. See [docs/LP_REBALANCE.md](docs/LP_REBALANCE.md).

**`live` — taker grid.** An explicit ladder of levels executed as swaps
through SwapRouter02. You choose every fill, and you pay the pool fee plus
slippage plus gas on each one. The core concepts are GRID, TRADES, INVENTORY,
PROFIT and USD VALUE.

The two are the *same strategy* at different cost structures: a V3 position is
already a grid with infinitely fine spacing, executed by the AMM for free. On
identical 5-minute Base ETH/USDC data the difference is large and consistent —
see [Which mode](#which-mode) below.

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
| `lp-live` | `npm run lp-live` | live Base pool price | V3 position mint/burn/collect via NonfungiblePositionManager |
| `lp` | `npm run lp` | CSV file | passive-LP sweep over range width and re-centring buffer |
| `optimize` | `npm run optimize` | CSV file | parameter sweep, ranked + out-of-sample |
| `walk-forward` | `npm run walk-forward` | CSV file | train → test folds |
| `compare` | `npm run compare` | saved runs | side-by-side comparison |

## Which mode

Identical strategy, identical data, identical config — only the cost structure
differs. Archived under `results/AUDIT-mode-taker/` and `results/AUDIT-mode-lp/`
with full provenance. Dataset `data/base-eth-usdc-5m.csv` (210,240 rows,
2024-08-22 → 2026-08-22), LP fee income calibrated from the measured pool APR
series, TVL floor $5M, lending yield **not** included.

Both columns below are the **grid** strategy — same levels, same resets — with
only the cost structure swapped (`--lp-mode 0/1`). It isolates what paying the
pool fee costs versus earning it. It is *not* a measurement of `lp-live`.

| | grid, paying the fee | grid, earning the fee |
| --- | --- | --- |
| Return | **−26.44%** | **+113.38%** |
| Max drawdown | −26.49% | −8.56% |
| Fee income | $0 | $16,821 |
| Fees + slippage + gas paid | $450 | $139 |

The entire positive return is fee income: grid P&L is $53 and $861 respectively
on $10,000 of capital — rounding error next to the cost structure. That is the
case for being an LP rather than a taker, and it is the most robust result in
this repository.

What `lp-live` actually runs — a single re-centred position — measures **+50.4%**
over the same window in-sample, and **loses money in 3 of 4 walk-forward folds**
(average −7.78%, `results/AUDIT-lp-oos-orig/`). The in-sample figure came from a
training window containing a large ETH run-up; it measured the market, not the
strategy.

A concentrated LP position is structurally long the volatile asset. It beat
holding ETH in 3 of 4 folds — the fee income is real — but beating ETH in a −39%
quarter still means losing 30% of the account.

A regime filter (`REGIME_MAX_MOVE_PCT`) that stands aside during big
directional moves reliably cuts the worst fold from −29.7% to roughly −10%, at
the cost of being parked 55–69% of the time. It removes the drawdown; it does
not create return.

**So: the cost-structure result is solid, the parameter choice is not, and no
configuration tested is yet a strategy worth funding.** Run
`npm run lp -- --folds 4` and judge on the out-of-sample table, never the
full-period one. Read [docs/LP_REBALANCE.md](docs/LP_REBALANCE.md) before sizing
anything.

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

### Smart-reset guards

The reset is a risk mechanism; four deterministic guards keep it from being
the biggest cost center (on 2024–2026 real data they cut reset losses ~70%
and flipped a −2.9% default result to +3.4%):

* `RESET_CONFIRM_OBSERVATIONS` — price must close outside the band N
  consecutive extra observations before a reset fires (whipsaw filter).
* `RESET_VOL_POSTPONE` — postpone the liquidation while realized volatility
  exceeds the gate; sell in calmer conditions.
* `RESET_SELL_FRACTION` / `RESET_UNDERWATER_SKIP_PCT` — carry inventory
  instead of dumping: unsold lots are recovered by the re-centered grid's
  sell levels on the way back up.
* `RESET_HARD_DRAWDOWN_PCT` — backstop: portfolio drawdown from peak beyond
  this forces a full liquidation regardless of everything above, so carried
  inventory can never ride a collapse unbounded.

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

## Running the LP bot

`./start.sh` packages the whole launch: preflight checks, typecheck and tests,
a fresh 5-minute data pull to seed the regime filter, a summary of what is
about to run with the honest caveats, and the launch itself.

```bash
./start.sh                 # dry run — plans and logs, broadcasts nothing
./start.sh --live          # broadcast (asks you to type "deploy")
./start.sh --help          # all options
```

Defaults: ±5% band, re-centre beyond 50% of the half-width, regime filter on at
3% over 168h, 24h between re-centres. Override with `--range`, `--buffer`,
`--regime-move`, `--regime-hours`.

It refuses to start without `RPC_URL` and `POOL_ADDRESS`, and without a key or
wallet address. `--live` additionally requires `PRIVATE_KEY` and an interactive
confirmation. See [docs/LP_REBALANCE.md](docs/LP_REBALANCE.md) before funding
anything.

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

Prefer the **measured pool APR** calibration (`--apr-file`) over guessing a
volume share and depth — see `docs/LP_MODEL.md`. Fee income is adjusted for
concentration (a narrow band earns more per dollar than a wide one) and
diluted by the pool's own liquidity density, so a position cannot earn more
than the fees the pool actually generates.

**Measured result** on real ETH with the measured Base WETH/USDC 0.05% APR
series, 2024-04 → 2026-08, $10k: the best grid configuration returns
**+100.1%** with a **−1.4%** max drawdown. Fee income (+$9,736) supplies
essentially all of it; trading nets +$338.

### Grid vs passive LP

Once fee income is modeled, the benchmark that matters is not ETH — it is a
**passive LP position in the same pool**. `npm run lp` runs that as a
first-class strategy, sweeps its parameters, and puts the winner head to head
with the grid over the same data:

```bash
npm run lp -- --csv data/eth-1h.csv --apr-file data/base-weth-usdc-005.csv \
  --min-pool-tvl 5000000
```

| | Grid (tuned) | Passive LP ±10% | Passive LP ±5% (re-centred) |
| --- | --- | --- | --- |
| Return | **+267.7%** | +114.4% | +104.4% |
| Max drawdown | **−1.4%** | −24.7% | −7.4% |
| Return / \|drawdown\| | **198** | 4.6 | 14.2 |
| Fee income | **+$28,214** | +$14,386 | +$20,283 |
| Position / trading P&L | −$1,149 | −$2,950 | −$9,689 |
| Transactions | 302 | 0 | 187 |
| Time earning fees | 35.4% deployed | 25.2% in range | 97% in range |

The grid wins on both axes once it is tuned tightly, and the reason is
mechanical: **re-centring is what keeps concentrated liquidity in range.** A
passive ±10% position drifts out of its band and stops earning — in range only
25% of the time. The grid follows price, so despite deploying just 35% of its
capital it collects nearly twice the fees. A passive position can only match
that by going very tight AND re-centring often, at which point it is paying
the same rebalancing costs the grid pays, with none of the spread capture.


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

### Optimization: walk-forward by default

`npm run optimize` no longer ranks configurations by full-period return —
that is how overfit winners get picked. By default it runs expanding-window
walk-forward folds, selects the configuration that wins the most folds
(consensus), and reports mean/worst out-of-sample returns alongside the
full-period figures as reference only. Set `OPTIMIZER_SELECTION=full` to get
the legacy behavior explicitly.

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

### Paper soak workflow

```bash
npm run paper 2>&1 | tee -a paper.log   # keep everything
npm run soak-report -- --log paper.log  # daily check (table + go/no-go hints)
```

The daily check looks at errors, drift warnings and portfolio trajectory.
Success criterion before the live pilot: realized fills within ~2x of the
modeled slippage, zero unexplained drift, no crash loops.

### Lending idle liquidity on Aave

Between grid fills most capital sits idle — usually USDC waiting for dips,
sometimes ETH waiting for rallies. With `ENABLE_AAVE=true` (live mode), the
bot supplies whatever exceeds a configurable liquid buffer to **Aave V3 on
Base** and earns supply yield on it:

* By default **all idle assets are lent**: both buffers default to `0`.
  Amounts below `LEND_MIN_ACTION_USD` stay in the wallet (gas-churn guard).
* The idle sweep runs every `LEND_INTERVAL_SECONDS`; newly freed capital
  (sell proceeds, unused buy budget) is lent on the next sweep.
* Before any BUY/SELL that would exceed the wallet balance, the shortfall is
  automatically withdrawn from Aave first — so trading works even with a zero
  liquid balance, at the cost of one extra transaction per fill. Set
  `LEND_BUFFER_USDC` / `LEND_BUFFER_ETH` > 0 to avoid that extra tx.
* Addresses default to the official Aave V3 Base deployments
  (`AAVE_POOL`, `aBasUSDC`, `aBasWETH`) sourced from the
  [aave address book](https://github.com/aave-dao/aave-address-book).

Paper mode reports what *would* be lent (`wouldLend` field).

Historical supply-rate data for this pool now exists — `npm run fetch-apr`
pulls it (`data/aave-base-usdc.csv`: 896 days, median **4.11%** APY), so the
backtest can model the yield rather than treating it as unquantified upside.
Analysis of what it is worth, and of the gas cost of keeping lent assets
withdrawable on demand, is in `docs/GAS_AND_LENDING.md`.

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
