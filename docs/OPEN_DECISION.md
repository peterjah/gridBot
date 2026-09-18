# Open decision: does this strategy work?

Status as of 2026-09-09. **One measurement decides it.** Everything else in
this repository is instrumentation for taking it.

## The question

Out-of-sample walk-forward return depends almost entirely on the fee rate the
pool actually pays, and nothing else moves the answer as much. Scaling the
input APR series, ±5% band with the regime filter at 3%:

| input fee APR | mean per 23d window | std err | windows positive |
| --- | --- | --- | --- |
| 73% | +3.83% | 2.39 | 12/20 |
| 62% | +2.71% | 2.31 | 12/20 |
| 52% *(series as fetched)* | +1.60% | 2.25 | 12/20 |
| 42% | +0.49% | 2.20 | 12/20 |
| **36%** | **−0.06%** | 2.18 | 11/20 |
| 31% | −0.60% | 2.16 | 10/20 |
| 26% | −1.15% | 2.14 | 10/20 |

Annualised figures are deliberately omitted: compounding a 23-day return to a
year and then averaging produces numbers like 340%, which is an artifact of the
window length rather than a result.

**Break-even is around 36% fee APR** — the point where a window ends with the
same dollars it started, measured over 20 paired windows with the park keeping
its real token mix.

An earlier figure of 28–30% here came from a model that sold the base side at
park. That cash parking avoided drawdowns the bot actually sits through, so it
broke even at a lower rate than the real strategy does.

The margin over break-even is not statistically established. At 52% input APR
the mean is +1.60% per window with a standard error of 2.25 — t ≈ 0.7, and 12
of 20 windows positive. "Probably above break-even" is the honest reading, not
"demonstrably".

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

* **Measured ≳ 60%** — clearly above break-even, and far enough that the margin
  survives the noise. Viable.
* **Measured ≈ 40–55%** — above break-even but inside the error bars. This is
  where the first live readings land (53.5% at 2.64 deployed-days). It means
  "not obviously losing", not "working".
* **Measured ≲ 36%** — at or below break-even. The capital would do as well in
  Aave for none of the risk.

The last outcome is not a failure of the exercise. Establishing that a strategy
does not work, with evidence, is the result.

## What this dataset can and cannot resolve

Measured 2026-09-17. Four folds of ~83 days, shipped configuration:

| folds | mean | std err | 95% CI on the mean |
| --- | --- | --- | --- |
| 4 | −2.68% | 11.13 | **[−24.5%, +19.1%]** |
| 8 | −1.50% | 5.03 | [−11.4%, +8.4%] |
| 16 | +0.18% | 2.72 | [−5.1%, +5.5%] |
| 24 | −0.90% | 1.69 | [−4.2%, +2.4%] |

At four folds the standard error on a *difference between two configurations*
is 12–15 points. Every comparison made in this project is smaller than that:

| comparison | difference | se | verdict |
| --- | --- | --- | --- |
| filter 3% vs off | −1.24 | 15.36 | noise |
| filter 3% vs 4% | −0.63 | 15.36 | noise |
| dwell 0/24 vs 24/24 | −4.02 | 13.16 | noise |
| band ±5% vs ±2% | +0.89 | 13.59 | noise |
| parkToCash off vs on | −6.38 | 12.42 | noise |

**The backtest cannot choose between configurations.** It resolves structural
facts — "earning the pool fee beats paying it" is a 140-point difference, far
outside the noise — and nothing finer. Treat every ranked table of
configurations in this repository as unresolved.

Pairing helps: run both configurations over the *same* windows and the
difference no longer carries the market's variance. Over 20 windows of ~23
days, paired against the shipped config:

| alternative | mean diff | se | t | wins |
| --- | --- | --- | --- | --- |
| parkToCash | −2.24 | 1.57 | −1.4 | 7/20 |
| hedge while parked | −2.38 | 1.57 | −1.5 | 6/20 |
| hedge continuous | −1.49 | 1.98 | −0.8 | 7/20 |
| filter off entirely | +1.79 | 0.91 | 2.0 | 13/20 |

Still nothing significant — and note `parkToCash` reverses sign against the
unpaired estimate that made it look attractive. **Use paired windows for any
future comparison**; the unpaired fold table is ~8× noisier and has repeatedly
produced signs that do not survive.

## The regime filter does not do what its name says

Structural, and independent of any point estimate: the filter parks by
withdrawing the position to loose tokens, and the live bot does not consolidate
them. Observed parked books held **35% and 61% of their value in ETH**.

So parking buys "stop re-centring into the move" and "stop earning fees", but
not "go flat". The directional exposure the filter exists to avoid is largely
retained. Removing it needs either `parkToCash` or the short hedge — neither of
which measurably helps, per the section above, but both of which would at least
make the mechanism match its description.

Worth knowing before trusting the filter to protect capital in a crash. It
mostly will not.

## What is already settled

These held up across every correction and do not need re-testing:

* **Earning the pool fee beats paying it.** −26.4% vs +113.4% on identical
  data, same strategy, only the cost structure differing. The most robust
  finding here.
* ~~**The regime filter helps.**~~ **Withdrawn.** Every version of this claim
  rested on a model that sold the base side at park, which the live bot never
  does. Corrected, and paired properly, the filter is indistinguishable from
  having none — and the only near-significant result mildly favours removing
  it. See the two sections above.
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
