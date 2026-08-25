# LP re-centring (`MODE=lp-live`)

The bot holds **one concentrated Uniswap V3 position** around the current
price and re-centres it when price drifts away.

This is the strategy the repository was originally built for, and — on every
measurement in `results/` — the one that makes money.

## Why an LP position is a grid

A V3 position between `Pa` and `Pb` holds

```
V = L · [ (√P − √Pa) + P · (1/√P − 1/√Pb) ]
```

which means the pool is continuously rebalancing you along the curve: as price
falls through the range your USDC is converted into ETH, as it rises the ETH is
converted back. That is exactly what a grid does — buy low, sell high, over and
over — with three differences, all in the LP's favour:

| | Taker grid (`MODE=live`) | LP re-centring (`MODE=lp-live`) |
| --- | --- | --- |
| Spacing | discrete levels you configure | continuous — the limit of infinitely fine spacing |
| Cost per fill | pool fee + slippage + gas | **zero** |
| Pool fee | you pay it | you **earn** a pro-rata share of it |
| Order size | configured | set by liquidity density = capital ÷ range width |
| Gas | one tx per fill | one tx per *re-centre* |

There is no maker/taker distinction on Uniswap. There is one pool fee (5 bps on
WETH/USDC on Base), paid by whoever swaps, distributed to whoever has in-range
liquidity. The grid mode is on the paying side of that; LP mode is on the
receiving side.

The catch is accounting, not economics. A grid *realizes* each round trip into
cash. An LP does not — the same buy-low/sell-high value stays as inventory and
shows up as **impermanent loss** against HODL, while the income arrives
separately as the fee stream. Same trades, different ledger.

## Parameters

Two numbers do almost all the work, and they carry over unchanged from the
sweep in `results/<label>/lp-optimization.csv`:

* **`LP_RANGE_PCT`** (`--lp-range`, column `range_pct`) — half-width of the
  managed range. Narrower concentrates liquidity, so it earns a larger share of
  the pool fee per dollar, but leaves range sooner.
* **`LP_RECENTER_BUFFER_PCT`** (`--lp-recenter-buffer`, column
  `recenter_buffer_pct`) — how far *past the range edge* price must go before
  re-centring, as a percent of the half-width. `0` re-centres the instant the
  position goes out of range; `50` tolerates drifting half a half-width beyond
  it first.

Both are converted to ticks at load time (`pctToTicks`), so the trigger is

```
thresholdTicks = pctToTicks(rangePct × (1 + bufferPct / 100))
```

`LP_WIDTH_TICKS` / `LP_THRESHOLD_TICKS` override the conversion if you want to
set ticks directly.

Supporting knobs: `LP_RECENTER_MIN_HOURS` (minimum hours between re-centres, so
a choppy market cannot burn the position down in gas and swap costs),
`LP_SLIPPAGE_BPS`, `POSITION_ID` (`0` mints a fresh position from the wallet
balances), `STATE_FILE`.

## What the buffer buys you

From `results/AUDIT-5m-grid-vs-lp/lp-optimization.csv`, ±5% range, 24h cooldown:

| buffer | return | max DD | time in range | fee income |
| --- | --- | --- | --- | --- |
| 0% (re-centre at the edge) | +57.9% | −34.2% | 10.9% | $6,396 |
| 50% | +50.4% | **−11.1%** | **88.8%** | $14,626 |

Re-centring with a buffer roughly triples time-in-range and cuts drawdown by
3× for about seven points of return. That trade is the single most important
decision in the whole system, which is why the buffer defaults to 50.

> **Caveat.** This table is full-period and in-sample; walk-forward rejects the
> row it recommends (see below). The tight-band rows also produce gross
> magnitudes that are not trustworthy ($14,626 of fees against −$9,454 of position P&L on $10,000 of
> capital). The model has no re-centring latency and no adverse selection, both
> of which hurt narrow ranges most. Treat the *ranking* between rows as
> informative and the *absolute levels* as an upper bound.

## Measured: paying the pool fee vs earning it

Identical strategy, identical data, identical config — only the cost structure
differs (`--lp-mode 0/1`). Archived under `results/AUDIT-mode-taker/` and
`results/AUDIT-mode-lp/` with full provenance.

Note both columns are the **grid** strategy. This isolates the cost structure;
it is not a measurement of the re-centring bot this document describes.

Dataset `data/base-eth-usdc-5m.csv`, 210,240 rows, 2024-08-22 → 2026-08-22.
LP fee income calibrated from the measured pool APR series, TVL floor $5M,
lending yield **not** included.

| | taker | LP |
| --- | --- | --- |
| Return | **−26.44%** | **+113.38%** |
| Max drawdown | −26.49% | −8.56% |
| Fee income | $0 | $16,821 |
| Fees + slippage + gas paid | $450 | $139 |
| Resets | 18,139 | 66 |

The entire positive return is fee income. Grid P&L is $53 / $861 on $10,000 —
rounding error next to the cost structure.

`lp-live` itself — one re-centred position, ±5% with a 50% buffer — measures
**+50.4%** over the same window (`results/AUDIT-5m-grid-vs-lp/`).

## Out-of-sample validation — read this first

`npm run lp --folds N` runs expanding-window walk-forward: each fold selects a
configuration on the training window alone and applies it, unchanged, to the
unseen chunk that follows. Passive LP re-opens at the first price of whatever
window it is given, so nothing leaks backwards.

Run on `data/base-eth-usdc-5m.csv` with the axes that produced the headline
in-sample numbers (`results/AUDIT-lp-oos-orig/`, ranked by RETURN):

```
Fold      Range   Recentre   Train ret  Train/yr   Test ret   Test/yr  Test ETH   vs ETH
Fold 1    ±5%     50%         +186.46%  +162.52%    -13.70%   -50.95%   -25.13%  +11.43%
Fold 2    ±5%     50%         +147.31%  +100.97%    -29.72%   -78.99%   -38.64%   +8.93%
Fold 3    ±5%     50%          +82.42%   +48.38%    +19.67%  +128.07%   +11.35%   +8.32%
Fold 4    ±5%     50%          +84.71%   +42.25%     -7.39%   -25.65%   +14.14%  -21.53%

Profitable out-of-sample folds:  1/4
Average out-of-sample return:    -7.78%  (-6.88% annualized)
Worst out-of-sample fold:        -78.99% annualized
Folds beating ETH hold:          3/4
Distinct winning configurations: 1/4  (selection is stable)
```

**The parameter choice does not generalize.** ±5% with a 50% buffer wins every
training window and loses money in three of the four windows that follow. A
stable selection that is consistently wrong is not validation.

Widening the axes makes it worse, not better: adding ±2% and a 100% buffer and
ranking by RISK_ADJUSTED (`results/AUDIT-lp-oos/`) selects ±2% in 4/4 folds for
a mean out-of-sample **−8.26%**, worst fold −68.78% annualized. The sweep keeps
reaching for the narrowest band because concentration raises modelled fee income
and the model charges nothing for it — no re-centring latency, no adverse
selection, no MEV. Narrow bands are where those omissions bite hardest.

### What the folds actually say

The out-of-sample losses track ETH, not the parameters:

| fold | test window | ETH move | LP return |
| --- | --- | --- | --- |
| 1 | 2025-09-24 → 2025-12-09 | −25.1% | −13.7% |
| 2 | 2025-12-09 → 2026-03-01 | −38.6% | −29.7% |
| 3 | 2026-03-01 → 2026-05-20 | +11.4% | +19.7% |
| 4 | 2026-05-20 → 2026-08-22 | +14.1% | −7.4% |

A concentrated LP position is **structurally long the volatile asset**. It beats
holding ETH in 3 of 4 folds — the fees are real and they do pay for something —
but beating ETH in a −39% quarter still means losing 30% of the account.

The in-sample +50.4% came from a training window that contained a large ETH
run-up. It measured the market, not the strategy.

Fold 4 is the one that should worry you most: ETH rose 14% and the position
still lost 7.4%, underperforming a hold by 21.5 points. That is re-centring
churn — the position repeatedly realizing a loss and re-opening at a worse
level — and it is the failure mode no amount of fee income fixes.

### Consequences

* The shipped defaults (`LP_RANGE_PCT=5`, `LP_RECENTER_BUFFER_PCT=50`) are a
  **fit, not a recommendation**. They are kept as defaults only because no
  better-evidenced value exists; replacing them with a different unvalidated
  guess would not be an improvement.
* Judge configurations on `--folds`, never on the full-period table.
* Until adverse selection and re-centring latency are in the model, treat any
  ranking that favours a band under about ±10% as an artifact.
* The unhedged directional exposure is the dominant risk, not the parameters.
  A regime filter or a short hedge addresses it; tuning range width does not.

## The regime filter — "run it sideways, stop on big moves"

Since the out-of-sample losses track ETH rather than the parameters, the obvious
remedy is to stop holding the position during big directional moves.
`REGIME_MAX_MOVE_PCT` (sweep axis `--lp-regime-moves`) closes the position to
cash when the trailing move over `REGIME_LOOKBACK_POINTS` observations exceeds a
threshold, and re-opens when it falls back. The decision is causal — index `i`
looks back to `i - lookback`, never forward — and standing aside is charged in
full: the whole ETH side is sold on exit and bought back on re-entry, and no
fees accrue in between.

Measured on the four walk-forward test windows with ±5%/50% held fixed, so the
only thing varying is the filter. Cells are `return% / percent of time parked`:

```
lookback = 2016 obs (7 days)
window   ETH move           off            2%            3%            5%           10%
Fold 1     -25.1%       -13.7/0        3.4/68        0.5/66       -4.0/58       -3.1/34
Fold 2     -38.6%       -29.7/0      -10.9/69       -8.7/65      -15.6/51      -21.3/23
Fold 3      11.4%        19.7/0       17.8/56       16.4/51       13.3/41       15.3/12
Fold 4      14.1%        -7.4/0        5.8/66        6.4/58       10.5/46       -2.4/28
mean                      -7.8%         +4.0%         +3.6%         +1.0%         -2.9%
worst                    -29.7%        -10.9%         -8.7%        -15.6%        -21.3%
profitable                  1/4           3/4           3/4           2/4           1/4
```

**What is robust: the filter cuts tail risk, substantially and at every
setting.** The worst fold improves from −29.7% to between −9% and −15% across
every threshold and every lookback tried (1, 7 and 28 days). That is the result
to keep.

**What is not robust: the positive mean.** It exists only at a 7-day lookback.
At 1 day the same thresholds average −6.2%, at 28 days −3.0%. A result confined
to one cell of a grid, with sign changes on either side, is a fit — and note
that this grid was scored on the test windows, which is precisely the selection
error walk-forward exists to prevent. Do not read +4.0% as an expected return.

**What it costs.** The filter is parked 55–69% of the time at the thresholds
that help. It is out of the market more than it is in it, so it earns close to
nothing — and a position earning nothing has a benchmark, which is a money
market, not zero.

So: the filter converts a strategy that loses money into one that roughly breaks
even, mostly by not being invested. That is a real improvement in risk and not a
source of return.

One further caution: the sweep will not choose this for you. Ranked by RETURN,
`--lp-regime-moves` selects "off" in all four training windows, because every
training window is a bull market where standing aside costs return. The filter
only looks good on the windows it was not selected on.

## Still not validated

1. **The fee model is optimistic where it matters most.** No re-centring
   latency, no adverse selection, no MEV — all three penalise narrow ranges.
2. **One regime.** Two years, one asset, one chain.
3. **Nothing has run on-chain.** The executor is dry-run verified against live
   Base state, but no position has been minted, re-centred or collected in
   production. Real fee accrual and real gas per re-centre are unmeasured.
4. **Archived results predate the current code.** Older runs in `results/` carry
   `srcSha256: ba44ed22d3b25d2a`; the tree has moved on. By this repo's own
   provenance rule they are not comparable to a run made today.

## Running it

Defaults to a dry run: every step is planned, quoted and logged, and nothing is
broadcast.

Turn the regime filter on. It is off by default because it changes the
strategy, but the measurements above say the strategy loses money without it:

```bash
npm run lp-live -- --lp-range 5 --lp-recenter-buffer 50 \
  --lp-regime-move 3 --lp-regime-hours 168
```

The live filter expresses its lookback in **hours**, not observations: 2016
observations of 5-minute data is 168 hours. It samples the pool price once an
hour and persists the window in `STATE_FILE`, so a restart does not blind it.
On a fresh deployment it seeds the window from `CSV_FILE`, and warns if that
file is stale enough to leave a hole. Until the window is covered the filter
reports `UNKNOWN` and stays invested — the same convention as the backtest, and
a reason to run `npm run fetch-data` before starting.

### Measuring fee income

Each re-centre reports the fees actually collected:

```json
{"msg":"Fees collected","WETH":"0.0041","USDC":"9.82","feeUsd":"19.9612",
 "cumulativeFeeUsd":"137.4410","recenters":7,"daysDeployed":"21.40"}
```

Fees are the difference between what `collect` transferred and what
`decreaseLiquidity` released — a `collect` after a withdrawal moves principal
and fees together, so the Collect event alone would report the whole position as
income. The running total is persisted, because it cannot be recovered from the
chain afterwards. This is the number to compare against the model's prediction,
and the reason to run live at all.

```bash
npm run lp-live -- --lp-range 5 --lp-recenter-buffer 50
```

Broadcasting requires **both** `DRY_RUN=false` and `LIVE_CONFIRM=yes`:

```bash
DRY_RUN=false LIVE_CONFIRM=yes npm run lp-live -- --lp-range 5 --lp-recenter-buffer 50
```

Each cycle reads pool state and the managed position, and logs the decision:

```json
{"msg":"Monitor cycle","price":2474.67,"currentTick":-198182,
 "positionCenterTick":-198180,"distanceFromCenter":2,"thresholdTicks":723,
 "rebalanceDecision":"HOLD","dryRun":true}
```

On `REBALANCE` it runs `decreaseLiquidity` → `collect` → (optional
`exactInputSingle` to rebalance the token ratio) → `mint`, then persists the new
token id to `STATE_FILE` so restarts follow the right position.

The chain is the source of truth throughout: balances are re-read after closing
and after the swap, and the mint amounts are recomputed from live balances, so a
partial failure is recoverable by simply running the next cycle.

## Operational notes from the first live run

2026-08-25, Base, ~$41 of test capital. The strategy logic behaved correctly —
the regime filter read +30.5% over 168h, called `HOSTILE`, and closed the
position rather than deploying into a run-up. The plumbing failed in four ways,
all now fixed and covered by tests.

**Never run two instances against one wallet.** Two bots allocate the same
nonce and fight over the same position. The first run produced
`replacement transaction underpriced` and a position that appeared in state
without either instance logging a mint. `lp-live` now takes an exclusive lock
on `<STATE_FILE>.lock` at startup and refuses to start if a live process holds
it; a lock left by a dead process is reclaimed automatically.

**A failed `collect` used to strand funds.** `closePosition` returned early on
zero liquidity, so when `decreaseLiquidity` succeeded and `collect` failed, the
principal and fees sat in the position as `tokensOwed` and every later cycle
skipped them. It now collects whenever liquidity **or** owed tokens are
non-zero. Nothing was actually lost in the incident, but the code path was
capable of losing everything withdrawn.

**Fee accounting must never abort the transaction sequence.** Reading a receipt
with `getTransactionReceipt` immediately after `waitForTransactionReceipt` can
hit a load-balanced node that has not seen the block yet, which threw and
aborted the cycle *between* `decreaseLiquidity` and `collect` — the exact
window that strands funds. Receipts are now read with
`waitForTransactionReceipt`, and both the read and the state write are
non-fatal.

**Nonces are tracked locally.** After a receipt arrives the RPC may still
report the pre-transaction pending nonce, so back-to-back sends reused it. The
transactor now allocates nonces itself, serializes sends, and resyncs from the
chain once on a nonce rejection.

If a run is interrupted mid-sequence, the recovery path is simply to start
again: the chain is the source of truth, and the next cycle collects anything
left owed before doing anything else.

## Choosing parameters

Sweep on history first, then deploy the winning row:

```bash
npm run lp -- --csv data/base-eth-usdc-5m.csv \
  --apr-file data/base-weth-usdc-005.csv --min-pool-tvl 5000000 \
  --lp-ranges 2,5,10,15,20 --lp-recenter-buffers 0,25,50,100 \
  --label my-sweep
```

Always pass `--folds`. The runner then selects by fold consensus rather than by
the full-period winner, writes `results/my-sweep/lp-walk-forward.csv`, and says
so in the run record. Read the chosen configuration off the SELECTION block, and
check its out-of-sample column before deploying it — on this dataset the
consensus pick is stable and still loses money, which is a reason not to deploy,
not a reason to look at the full-period table instead.

See [ACCOUNTING.md](ACCOUNTING.md) for why raw return is the wrong ranking
target.
