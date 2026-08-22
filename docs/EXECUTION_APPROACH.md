# How grid levels map to Uniswap V3

The spec asked for an explicit investigation of how to represent grid orders
on Uniswap V3 before building execution. This document records the analysis
and the chosen approach.

## The options

### Approach A — narrow V3 liquidity ranges as grid slots

Each grid level becomes a concentrated liquidity position straddling that
level (e.g., `[level - s/2, level + s/2]`). When price crosses the range, the
position converts fully from one asset to the other — mechanically similar to
a limit order filled with bonus fee earnings.

* Pros: earns swap fees on every fill; capital efficiency.
* Cons: one NFT position per active grid slot; requires continuous mint/burn/
  collect lifecycle management; gas costs scale with grid size; removing a
  position mid-crossing is racy; rebalancing tokens after each fill adds
  another swap per cycle.

### Approach B — V3 range orders (one-sided liquidity)

A special case of A: place single-sided liquidity entirely above or below the
current price in a narrow range. When price crosses it, it becomes fully
one-sided in the other token — a virtual limit order that must then be
collected and re-placed on the other side of the level.

* Pros: closest thing V3 offers to native limit orders; earns fees while
  resting; no slippage at all (fill happens at the pool price inside the
  range).
* Cons: same multi-position lifecycle complexity as A, plus the well-known
  "range order race": you cannot tell from outside whether your range was
  fully crossed, so re-placing requires careful position accounting.

### Approach C — swaps when levels are crossed (chosen for V1)

Grid levels live purely in the strategy layer as virtual limit orders. When
the strategy observes that a level was crossed, it executes a market swap via
SwapRouter02 (`exactInputSingle`) sized to the grid order.

* Pros: simplest faithful representation of the grid model; one code path;
  deterministic backtest ↔ live parity (same actions, same sizing); reuses
  battle-tested router/quoting infrastructure; gas cost is one swap per fill.
* Cons: pays pool fee + slippage on every fill instead of earning fees; fills
  happen at observation time, not exactly at the level price.

## Decision

**V1 uses Approach C.**

Rationale:

1. The first milestone is answering *"does this strategy make money after
   costs?"* — Approach C makes costs **visible and conservative** (fee +
   slippage modeled per fill), which is exactly what the question requires.
   Approaches A/B would flatter results with fee income before the core edge
   is proven.
2. Strategy/execution separation is preserved completely: `GridStrategy`
   emits `BUY` / `SELL` / `LIQUIDATE` actions and knows nothing about how they
   are executed. Upgrading to B later changes only `src/execution/`.
3. Operational risk stays low while the strategy is unproven: no NFT position
   management, no partial-fill states to recover from.

## Upgrade path (if the edge proves out)

If backtests show the strategy is viable but fee/slippage drag is the main
cost, migrate to Approach B:

1. Replace resting-order fills with one-sided range positions placed at each
   active level.
2. Poll crossing state per position (liquidity going from >0 to 0 in-range →
   crossed) and recycle positions to the paired side.
3. Keep the same `TradingExecutor` interface so `GridStrategy`,
   the backtester, paper and live runners are untouched.
