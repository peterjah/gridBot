# Open decision: does this strategy work?

Status as of 2026-09-09. **One measurement decides it.** Everything else in
this repository is instrumentation for taking it.

## The question

Out-of-sample walk-forward return depends almost entirely on the fee rate the
pool actually pays, and nothing else moves the answer as much:

| fee scale | implied APR | ±5% band mean | ±3% | ±2% |
| --- | --- | --- | --- | --- |
| ×1.00 | 140% *(model)* | +3.6% | +4.2% | +6.3% |
| ×0.80 | 112% | +1.1% | +0.3% | +1.3% |
| ×0.60 | 84% | −1.4% | −3.5% | −3.5% |
| ×0.35 | 50% *(pool apyBase median)* | −5.7% | −9.9% | −11.4% |
| ×0.19 | 27% *(rough live estimate)* | −6.3% | −10.8% | −12.5% |

**Break-even is around 120% fee APR.** Below it, every band and every
configuration is negative out of sample.

The model says 140%. The pool's published `apyBase` median is ~50%. A rough
live estimate over ten badly-under-deployed days suggested ~27%. Those cannot
all be right, and the strategy is viable under only the first.

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

* **Measured ≳ 120%** — the model was right, the strategy is viable, and the
  narrow-band configurations become worth revisiting (±2% measured best under
  the model's own fee assumption).
* **Measured ≈ 50%** — in line with the pool's published rate, meaning
  concentration delivers nothing. Every configuration is negative; the
  strategy does not work at this size on this pool.
* **Measured ≈ 27%** — worse than the published rate, implying adverse
  selection on top. Same conclusion, more firmly.

The second and third outcomes are not failures of the exercise. Establishing
that a strategy does not work, with evidence, is the result.

## What is already settled

These held up across every correction and do not need re-testing:

* **Earning the pool fee beats paying it.** −26.4% vs +113.4% on identical
  data, same strategy, only the cost structure differing. The most robust
  finding here.
* **The regime filter helps, and helps more as fees fall.** Off vs on:
  −7.8% → +3.6% under the model, −29.8% → −6.4% under the live-calibrated
  rate. Its benefit is constant while its cost shrinks with the fee rate.
* **Realized volatility is not a better regime metric than displacement**, and
  a signed (falls-only) variant measured worse than absolute.
* **The hedge as shipped is the wrong tool** while parked, where the ETH can
  simply be sold. It stays off. See docs/LP_REBALANCE.md.
* **The distance re-centre trigger is effectively dead** — the regime filter
  fires first 88% of the time. Fixing that coherence problem only pays in a
  fee regime we have no evidence for, so the band stays at ±5%.

## Standing caveat

Everything above rests on four folds, one asset, one pool, one two-year window.
The *rankings* have been stable across many corrections; the *levels* have been
wrong repeatedly and always in the optimistic direction. Treat any single cell
of any table here as a fit, not a forecast.
