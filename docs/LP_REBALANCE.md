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

## Choosing the regime metric

`trailingMovePct` is net **displacement** — where price ended versus 168h
earlier, two points out of the whole window. It is not a volatility measure: a
week that runs +20% and returns to flat reads 0%, while one that grinds +4%
steadily reads hostile.

That looks like an obvious thing to improve, so `REGIME_METRIC` makes the choice
a sweepable axis and the question was settled by measurement:

* `displacement` — |end/start − 1|, the shipped default
* `signed` — park only on a FALL, since an LP is structurally long
* `drawdown` — worst peak-to-trough inside the window
* `volatility` — realized volatility of log returns, the conventional answer

Out-of-sample folds, ±5% band, 50% buffer, best threshold for each:

| metric | best mean | worst fold | parked |
| --- | --- | --- | --- |
| none | −7.78% | −29.7% | 0% |
| **displacement 2–3%** | **+4.03%** | −8.7% | 60–65% |
| drawdown 4–6% | +3.51% | **−5.3%** | 69–82% |
| volatility 5–6% | +3.18% | **−3.2%** | 72–85% |
| signed | +2.22% | −13.5% | 33% |

**Two findings worth keeping.**

*Realized volatility is not an improvement on displacement.* At a loose
threshold it is the worst option in the table (−7.97% mean at 12%, barely
distinguishable from no filter). It only looks respectable when tightened far
enough to park 72–85% of the time, at which point it is closer to "mostly not
invested" than to a filter.

*Signed is worse than absolute, which contradicts the correlation study that
suggested it.* Grouping past weeks by direction showed falls followed by −0.63%
and rallies by +1.24%, implying the filter should ignore rallies. Simulated, it
is worse at every comparable threshold. The correlation was over single forward
weeks; the folds are quarters, and what the filter actually does is sit out
sustained declines rather than pick individual weeks. **The direct simulation is
the one that decides — it evaluates the decision actually being made.**

**Threshold sensitivity matters more than the metric.** Averaged across
thresholds, all four land between +0.9% and +2.1% mean; each has a bad cell.
Displacement has the best single cell, drawdown and volatility the most
forgiving tails. Reading any one row as "the answer" would be fitting a cell.

The default stays `displacement` at 3%: best measured mean, and the only
configuration with live evidence behind it. `drawdown` at 5–6% is the
alternative worth considering if tail risk matters more than return — it halves
the worst fold, at the cost of being parked far more.

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

### Hysteresis on re-entry (`LP_REGIME_REENTER_MARGIN_PCT`)

Re-entering the instant |move| dips back under the exit threshold flips
park/deploy on every oscillation around it, and each flip pays a full sell +
buy-back spread plus gas. With `--lp-regime-reenter-margin 25` (default) the
bot exits above 3% but only re-enters below 2.25%. Set `0` for symmetric
behaviour. The margin trades a little late re-entry for far fewer whipsaw
cycles; there is no measurement behind the default, so treat it like every
other unvalidated parameter here.

### Short hedge while parked (`HEDGE_ENABLED`)

The filter's documented failure mode is directional: out-of-sample losses track
ETH, and going to cash merely stops paying for the move. While parked, the bot
can instead **short** it:

1. `parkIdle` supplies idle USDC/WETH to Aave (collateral);
2. the hedge borrows WETH against that collateral and sells it for USDC;
3. on re-entry it buys the WETH back and repays before anything deploys.

The parked book then holds roughly zero ETH delta instead of merely being
uninvested — fold 1/2-style drawdowns become flat-to-positive, at the cost of
variable borrow-rate carry and two swap legs per park/unpark cycle. The chain
decides whether a hedge exists (the variableDebtToken balance), so a crash
mid-unwind recovers by simply running the next cycle.

```bash
HEDGE_ENABLED=true HEDGE_RATIO_PCT=50 HEDGE_MAX_LTV_PCT=40 npm run lp-live -- \
  --lp-regime-move 3 --lp-regime-hours 168
```

`HEDGE_RATIO_PCT` is the share of ETH exposure to short (100 = fully neutral
while parked); `HEDGE_MAX_LTV_PCT` is a hard safety cap well below Aave's
liquidation LTV — the borrow is min(ratio target, this capacity). Requires
`ENABLE_AAVE=true`. Nothing about this is validated by the backtests; measure
live before trusting it.

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

Unattended, the Docker stack supervises the process and keeps logs in the
Docker daemon (`docker compose logs -f`) rather than a file:

```bash
docker compose up -d
```

`./start.sh` runs the same bot in the foreground for development. Either way it
defaults to a dry run: every step is planned, quoted and logged, and nothing is
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

## Lending idle capital

The regime filter is parked 55-69% of the time at the thresholds that help, and
cash sitting in the wallet earns nothing. That idleness is the largest cost of
running the filter. `ENABLE_AAVE=true` supplies idle USDC and WETH to Aave V3
while standing aside.

The invariant is that **lent assets are always available for LP**:

* `releaseAll()` withdraws everything before the bot deploys, and the monitor
  awaits it *before* anything reads a wallet balance. The rebalance plan sizes
  the position from that balance, so deploying first would fund the position
  from the un-lent remainder and quietly leave the rest in Aave. A test pins
  the ordering.
* `releaseAll()` applies no minimum. A threshold there would leave a remainder
  behind; withdrawing dust costs a few cents, under-deploying costs yield.
* `parkIdle()` does apply `LEND_MIN_ACTION_USD` (default $100), so gas is never
  spent moving dust into Aave. It runs on every hostile cycle, not only the one
  that closes the position, so a deposit arriving mid-park is picked up.
* A failure to supply is logged and swallowed. Yield is an optimisation and must
  never break the risk control; a failure to *withdraw* is not swallowed,
  because deploying after one would under-fund the position.

Native ETH for gas is untouched — Aave holds WETH, which is a separate balance.

**Supply and withdraw are separate transactions.** Aave's Pool has no batch
entry point, and SwapRouter02's `multicall` delegatecalls into itself, so it
cannot reach an external contract. Combining an Aave withdrawal and a Uniswap
action atomically needs a smart account (EIP-7702). At the Base gas prices
observed live (~$0.006 per transaction) that complexity does not pay for itself.

One caution: Aave's supply APR on Base stablecoins is typically low single
digits, and the bot only earns it while parked. On a $10,000 account parked 65%
of the time at 3% APR that is roughly $195/year — real, but not what decides
whether this strategy works.

## Hedge safety and liquidation risk

**`HEDGE_ENABLED` is off, and should stay off in its current form.**

It borrows WETH against supplied collateral while the bot is parked and sells
it, so the parked book is flat against ETH rather than merely uninvested. That
works, but it is the wrong tool for this particular job.

While parked, the ETH is loose tokens. Selling them reaches a flat book in one
step. The hedge instead supplies that same WETH as collateral and borrows it
back to cancel it out:

| | ETH exposure |
| --- | --- |
| supplied X WETH | +X |
| borrowed Y WETH | −Y |
| USDC from the sale | 0 |
| **net** | **X − Y** |

Setting Y = X is flat — and so is simply holding no WETH. Both paths cost the
same two swaps (out, and back on re-entry, which `rebalance` performs anyway).
The borrow path adds three transactions, a permanent borrow-minus-supply rate
spread, and liquidation risk, for no additional hedging.

A borrow earns its keep only against exposure that **cannot be sold** — the LP
position's own delta while deployed, where selling means withdrawing and
defeats the point. The shipped hedge covers the parked leg instead, which is
exactly the case that does not need it. That is also why the backtest scores it
at zero: the parked book in the model is all USDC, so there is nothing to
short.

Walk-forward agrees on the numbers: the regime filter alone averages +3.6% out
of sample against +0.2% for filter-plus-hedge.

The guards below are sound and are kept, so the machinery is ready if the hedge
is ever moved to the deployed leg — the case worth having, which moved the four
folds from −7.8% to −3.7% mean and halved the worst one.

### Guards, if it is enabled anyway

**The de-leverage ordering.** The debt is repaid before any collateral is
withdrawn. `hedge.close()` runs first in the deploy path, then
`lending.releaseAll()`, then the position is funded — so a live LP is never
funded from a wallet that also owes WETH, and collateral is never pulled out
from under an open debt. Errors propagate rather than being swallowed:
deploying long while still short is worse than a delayed entry.

**The health-factor guard.** `checkHealth()` reads Aave's own
`getUserAccountData` — its oracle prices and the live liquidation threshold,
not the bot's estimate from pool prices — on *every* parked cycle, and unwinds
the hedge when the health factor reaches `HEDGE_MIN_HEALTH_FACTOR` (default
1.6, against liquidation at 1.0).

This guard is not optional decoration. A short loses as ETH rises, and the
regime filter keeps the bot parked precisely while a large move is running:
"still parked" and "health factor degrading" are the same market condition, not
independent events. Nothing else closes the hedge until the market calms, which
may be after liquidation. When the guard fires it unwinds and does **not**
re-open on the same cycle, since the regime that forced the unwind is still
present.

**The opening cap.** `HEDGE_MAX_LTV_PCT` (default 40) caps borrowed value
against supplied collateral, well inside Aave's own liquidation LTV. Only
supplied assets count as collateral; idle wallet balances do not. Note this cap
uses pool prices, so it is an estimate — the health factor above is the
authority.

**Funding the buy-back.** `parkIdle` supplies the whole wallet on every hostile
cycle, including the USDC the hedge raised when it opened. `close()` therefore
withdraws the shortfall from collateral before buying back — the minimum
needed, not everything, because withdrawing against open debt raises the LTV.
It logs the health factor after that withdrawal, and refuses with a clear
message rather than reverting on-chain if nothing can fund it.

**Recovery.** The chain decides whether a hedge exists: `isOpen()` reads the
variable-debt balance rather than a local flag, so a crash mid-unwind is
resolved by running the next cycle. Every leg is a plain single call.

Still unproven: none of this has run on-chain. The guards have unit tests and
the ordering is pinned by tests, but a borrow path deserves a fork test before
real funds. Keep `HEDGE_ENABLED=false` until that exists — and note that the
walk-forward above says the regime filter alone outperforms filter-plus-hedge
on the configuration the backtest can score.

## Sizing a position from value, not from balances

Uniswap's `getLiquidityForAmounts` returns the most liquidity mintable from the
balances **as they stand**, which is the minimum of what each side supports.
That is the right question at mint time, once balances have been swapped to the
target ratio. It is the wrong question when planning.

With a one-sided wallet the minimum collapses to nearly zero, the required
amounts collapse with it, and `planBalancingSwap` — which compares required
against held — then sees no imbalance to correct. Nothing gets swapped, so the
wallet stays one-sided. Circular.

Measured on the live wallet (0.1414 WETH, 0.000001 USDC, ±5% band):

| | liquidity | required | swap | deployed |
| --- | --- | --- | --- | --- |
| min-of-sides | 851,479 | 0.00000000042 WETH | none | **$0.00** |
| by value | 144,681,676,673,633 | 0.0721 WETH + 169.92 USDC | 0.0693 WETH → USDC | **$346.84** |

The planning step now uses `getLiquidityForValue`, which prices the whole
holding and asks what liquidity that value funds at the current price, so the
balancing swap has a real target to move toward. Minting still uses
min-of-sides, which is correct there — after the swap it is the safe amount to
actually commit.

This bug was silent rather than loud: the mint reverts only when the wallet is
almost entirely one-sided. Milder imbalances simply under-deployed, leaving the
remainder idle. The position holding $49.95 while $346.85 sat in Aave was this,
not only the missing redeploy trigger.

## Planning after the close, not before it

The rebalance plan used to be computed once, from the wallet as it stood
*before* the position was closed — so it excluded everything the position was
about to release. The swap was sized for the wallet alone, and whatever the
position gave back only reached the mint, where min-of-sides quietly discarded
the surplus.

Live consequence: a $397 book deployed $52 and left $345 idle, because the
wallet held only WETH (just withdrawn from Aave) while the position held the
USDC side.

The plan is now recomputed after closing, against balances that include the
released tokens. The pre-close plan is kept for the log and the dry run, and
both go through the same `planFor` so they cannot drift apart.

Every balance read that follows a transaction now waits for that transaction to
be visible — after the collect, after the balancing swap, and before the park
supplies to Aave. The transport fails over across endpoints, so the node answering that
read is not necessarily the one that confirmed the transfer — reading early
returns the pre-close balances and everything downstream is sized against
capital that is in the wallet but invisible. After the timeout it proceeds with
what it can see rather than throwing: an under-read costs a smaller position,
refusing to proceed leaves the capital undeployed entirely.

This class of bug is easy to underestimate. A confirmed receipt does not mean
the next read sees the result: the swap and the mint can land in the SAME
block, and the transport fails over across endpoints. Every occurrence so far
has been silent — the wrong number, not an error:

* a swap of 0.0702 WETH → 172.26 USDC confirmed, the read still showed the
  pre-swap 26.21 USDC, and the mint deployed $52 of a $397 book;
* the park supplied 0.0703 WETH, then found another 0.0167 fifteen minutes
  later, leaving USDC below the supply threshold stranded in the wallet.

## Absorbing deposits

The bot moves capital only at transitions — park, re-enter, re-centre. Anything
deposited while a position sits quietly at its centre waits for the next one,
and with a 723-tick trigger plus a 24h cooldown that can be weeks. Observed
live: 0.14 WETH sat supplied to Aave while the LP position held everything else
and the log read `HOLD` at 53 ticks from centre.

`IDLE_REDEPLOY_PCT` (default 5) makes enough undeployed capital its own reason
to re-centre. A re-centre already withdraws everything and redeploys, so this
adds a trigger rather than new machinery.

Two gates, both of which must pass:

* **The percentage** stops a trivial top-up churning a large position.
* **`IDLE_REDEPLOY_MIN_USD`** (default 50) stops leftover dust churning a small
  one. Minting never consumes the wallet exactly, so against a small position a
  few cents of remainder can exceed any percentage — a floor is required or the
  bot re-centres in a loop on its own change.

The check counts the wallet **and** anything supplied to Aave: `parkIdle` may
have banked a deposit while the bot stood aside, and `releaseAll` only withdraws
at the moment it deploys.

It is evaluated only when a re-centre could actually follow — behind the
cooldown the balance read would spend RPC calls on a decision that cannot be
acted on. A failed read is logged and treated as "no idle capital", so an
accounting problem can never stop the bot from holding.

## Adaptive polling

The bot's decisions are bounded by slow-moving thresholds: a re-centre needs
price to travel hundreds of ticks, a re-entry needs a 168-hour trailing move to
decay, and the cooldown can block action for a full day. Polling every 30
seconds through all of that spends RPC quota re-reading a state that cannot have
changed — which is exactly how a paid endpoint's monthly allowance disappears.

`POLL_INTERVAL_SECONDS` is now the **floor**, not the interval. The bot polls
that fast only when something is close to acting, and otherwise backs off
toward `MAX_POLL_INTERVAL_SECONDS` (default 900).

At roughly three RPC calls per cycle:

| situation | interval | calls/day |
| --- | --- | --- |
| parked, ETH +30% over the week | 835s | 310 |
| parked, move decayed to 5% | 509s | 509 |
| parked, about to re-enter (2.3%) | 49s | 5,290 |
| deployed, sitting at centre | 610s | 425 |
| deployed, halfway to the trigger | 467s | 555 |
| deployed, near the trigger | 58s | 4,469 |
| deployed, 20h of cooldown left | 900s | 288 |
| *fixed 30s (previous behaviour)* | *30s* | *8,640* |

Two hard overrides sit above the urgency calculation:

* **A blocking cooldown outranks it.** No amount of price movement can trigger a
  re-centre until the cooldown expires, so the bot sleeps toward the expiry
  rather than watching a trigger that cannot fire.
* **An open short caps it** at `HEDGE_POLL_INTERVAL_SECONDS`, because
  liquidation risk does not care how quiet the rest of the state looks.

Nothing here can cause a missed action — the thresholds are unchanged and an
over-long interval costs only latency at the moment of action. The policy is a
pure function (`src/bot/polling.ts`) with the boundary behaviour pinned by
tests.

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
