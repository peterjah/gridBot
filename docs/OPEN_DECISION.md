# Open decision: does this strategy work?

Status as of 2026-09-09. **One measurement decides it.** Everything else in
this repository is instrumentation for taking it.

## The question

Out-of-sample walk-forward return depends almost entirely on the fee rate the
pool actually pays, and nothing else moves the answer as much. Scaling the
input APR series, ±5% band with the regime filter at 3%:

| input fee APR | mean fold (0.23y) | annualised | vs ETH hold |
| --- | --- | --- | --- |
| 52% *(series as fetched)* | +3.26% | +19.9% | +12.8% |
| 42% | +1.73% | +11.6% | +11.3% |
| 34% | +0.60% | +5.9% | +10.2% |
| 31% | +0.22% | +4.0% | +9.8% |
| 26% | −0.53% | +0.4% | +9.0% |
| 23% | −0.90% | −1.3% | +8.7% |

**Break-even is around 28–30% fee APR** — the point where a fold ends with the
same dollars it started. The more honest bar is slightly higher: idle capital
earns ~4% in Aave with no divergence loss and no gas, and that is met at ~31%.

Measured live so far: **63.2%**, over only 2.13 deployed-days at 100% in range
(2026-09-15). That is above break-even, but the sample is far too small and has
never been tested out of range, which is where the rate falls.

### A correction worth remembering

An earlier version of this file claimed break-even was **~120% fee APR** and
that the strategy was viable under none of the candidate rates. That was wrong.

The scan multiplied the input APR *series* by a scale factor, then labelled the
columns with the model's **post-concentration** implied rate for a ±5% band
(~140% at ×1.00). But the concentration multiplier is applied inside the model,
not to the input — so the labels were inflated by roughly 2.7× against the
quantity actually being varied. The scale factors and the returns were correct;
only the APR labels attached to them were wrong.

Compare like with like: the number the bot measures (`feeAprPct`) is the rate
earned per dollar deployed, which corresponds to the **input series**, not to
the model's internal post-concentration figure.

## What to do

1. **Let it run deployed.** The bot now measures the rate directly and logs
   `Measured fee rate` each cycle (see docs/LP_REBALANCE.md). Nothing
   accumulates while parked.
2. **Reset the fee counters at the next clean deploy.** `feesUsd` carries
   $3.28 of history with no matching `deployedUsdSeconds`, so the first weeks
   would read too high. Zero `feesUsd`, `deployedUsdSeconds`, `deployedSeconds`
   and `inRangeSeconds` together in `STATE_FILE`.
3. **Wait two to three weeks of full deployment.** Not wall-clock — the counter
   only advances while capital is actually at work.
4. **Then re-run the sweeps calibrated:**
   ```bash
   LP_FEE_APR_PCT=<measured> npm run lp -- --csv data/base-eth-usdc-5m.csv \
     --apr-file data/base-weth-usdc-005.csv --min-pool-tvl 5000000 --folds 4
   ```

## How to read the answer

* **Measured ≳ 50%** — comfortably above break-even. At the series rate the
  folds give ~+20% annualised and ~+13% over holding ETH. Viable, and worth
  re-running the band and threshold sweeps calibrated before scaling up.
* **Measured ≈ 30%** — at break-even. The strategy returns roughly nothing
  after divergence loss and costs, and the capital would do as well in Aave
  for none of the risk.
* **Measured ≲ 25%** — below break-even. The strategy does not work at this
  size on this pool.

The last outcome is not a failure of the exercise. Establishing that a strategy
does not work, with evidence, is the result.

## What is already settled

These held up across every correction and do not need re-testing:

* **Earning the pool fee beats paying it.** −26.4% vs +113.4% on identical
  data, same strategy, only the cost structure differing. The most robust
  finding here.
* **The regime filter helps, and its edge shrinks as fees rise.** Off vs best
  threshold: −7.8% → +5.7% at 52% APR, −1.4% → +7.8% at 63%, +8.9% → +11.0% at
  78%. Its benefit is roughly constant while its cost — fees forgone while
  parked — grows with the rate. Above ~80% it is nearly worthless.
* **Realized volatility is not a better regime metric than displacement**, and
  a signed (falls-only) variant measured worse than absolute.
* **The hedge as shipped is the wrong tool** while parked, where the ETH can
  simply be sold. It stays off. See docs/LP_REBALANCE.md.
* **The distance re-centre trigger is effectively dead** — the regime filter
  fires first 88% of the time, so `LP_RECENTER_BUFFER_PCT` tunes a mechanism
  that rarely acts.

## Reopened by the corrected fee rate

The band width was settled at ±5% on the argument that "at realistic fees, wide
bands lose least". That rested on the mislabelled columns: the panel it cited
was running at ~10% APR, not the ~27% it was labelled. At the rate actually
measured, the ranking reverses.

±5% band, regime 3%, dwell 0/24, at the live-measured rate:

| band | mean | worst | profitable | re-centres |
| --- | --- | --- | --- | --- |
| ±5% *(current)* | +4.81% | −5.5% | 3/4 | 3 |
| ±3% | +5.08% | −1.7% | 3/4 | 12 |
| **±2%** | **+5.49%** | **+2.1%** | **4/4** | 19 |
| ±1.5% | +5.31% | +2.8% | 4/4 | 25 |

±2% is the only configuration in this project where every out-of-sample fold
made money. It is **not** a recommendation yet: tight bands lean hardest on the
concentration multiplier, which is the part of the model the live measurement
exists to test, and 19 re-centres against 3 is six times the exposure to the
transaction path where every bug this month has lived.

Decide it with a measured `LP_FEE_APR_PCT`, not before.

The dwell choice is also closer than it looked. At realistic rates 24/24 beats
0/24 on mean (+6.26% vs +4.81%); 0/24 is kept for its better tail and because
the live failure it fixes — holding risk for a day because a churn guard
blocked the response — is a defect regardless of the mean.

## Standing caveat

Everything above rests on four folds, one asset, one pool, one two-year window.
The *rankings* have been stable across many corrections; the *levels* have been
wrong repeatedly and always in the optimistic direction. Treat any single cell
of any table here as a fit, not a forecast.
