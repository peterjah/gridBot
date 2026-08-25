# Reset guards: what fires, what cannot, and what costs money

Four guards can modify or block a reset. Measured on real ETH joined to the
measured Base WETH/USDC 0.05% APR series, 2024-04 → 2026-08.

| Guard | Verdict |
| --- | --- |
| `RESET_SKIP_COOLDOWN_WHEN_FLAT` | **net positive** — return improved in 1,196/1,696 paired configs, median +2.3 pts |
| `RESET_HARD_INVENTORY_LOSS_PCT` | **works where a backstop is meaningful** (wide grids, or re-centring disabled) |
| `RESET_HARD_DRAWDOWN_PCT` | **cannot bind** for this strategy — see below |
| `RESET_CONFIRM_OBSERVATIONS` | **net negative** — median −0.3 pts return, −0.65 risk-adjusted |
| `RESET_VOL_POSTPONE` | **net negative** — median −1.3 pts return, −1.26 risk-adjusted |

## Why the portfolio-drawdown backstop cannot fire

`resetHardDrawdownPct` compares total portfolio value against its peak. For a
fee-earning grid the portfolio is mostly cash plus accumulated fee income, so
the at-risk slice is small: a position **35% underwater** moves total
portfolio value by **about 2%**. A 20-25% threshold is therefore unreachable
in normal operation — across a 3,392-configuration sweep, enabling it at 20%
changed nothing at all, producing byte-identical medians and best cases.

`resetHardInventoryLossPct` measures the at-risk slice directly — open
inventory against its own cost basis — which is scale-free and can fire. It
pairs with `resetUnderwaterSkipPct`: carry small losses, cut large ones.

Two fixes were needed to make a backstop function:

1. **Measure the right thing** (inventory, not portfolio), as above.
2. **Evaluate it independently.** The check sat *inside* the band-exit branch,
   so it could only fire when a reset was already going to happen. It could
   not back-stop a collapse that stayed inside the band, nor a grid with
   `resetBufferLevels = 0`. It now runs before, and independently of, every
   other trigger.

Measured effect where a backstop is meaningful:

| Configuration | Return | Max DD | Risk-adj |
| --- | --- | --- | --- |
| ±30% buffer 5, no backstop | +71.6% | −2.65% | 27 |
| ±30% buffer 5, portfolio DD 20% | +71.6% | −2.65% | 27 (no change) |
| ±30% buffer 5, **inventory loss 15%** | **+86.8%** | **−0.86%** | **87** |
| re-centring OFF, no backstop | +25.2% | −4.38% | 6 |
| re-centring OFF, **inventory loss 25%** | **+33.6%** | **−2.80%** | **12** |

On the tuned tight configuration (1% / ±10% / buffer 1) it never binds: the
band exit caps the loss long before inventory is 15% underwater. A backstop is
insurance for wide grids and loose buffers, not for tight ones.

## Confirmation and vol-postpone

Both delay the liquidation. Both are net negative here, and for the same
reason the cooldown was: while the guard waits, price is outside the band, so
the grid earns no fees and cannot re-centre to start earning again.

The confirmation guard was improved — it is now skipped when the book is flat,
since its purpose is to avoid liquidating inventory at a local extreme and
there is nothing to liquidate when flat. That narrowed its cost (median
−2.1 → −1.5 points in the larger sweep) but did not reverse it.

An earlier note in this repository claimed confirmation "costs median return
while helping tail risk". **That was wrong.** Risk-adjusted return is also
worse: it improves in only 98/312 paired configurations, median −0.65. It
helps neither.

`.env.example` previously recommended `RESET_CONFIRM_OBSERVATIONS=2` and
`RESET_VOL_POSTPONE=true` while the code defaulted to `0`/`false`. Anyone
copying the example got both. The example now matches the code defaults.
