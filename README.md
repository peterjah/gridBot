# Uniswap V3 Liquidity Rebalancing Bot (Base)

A minimal, open-source bot that manages **one Uniswap V3 LP position** on the
**Base** network. It monitors the position, and when the pool price moves too
far from the position's center, it closes the position, collects fees,
rebalances the tokens with a swap, and opens a new position centered on the
current price.

> This is a small, understandable foundation — not a complete trading product.
> The strategy is isolated so you can replace it without touching the
> blockchain or Uniswap execution layers.

## Architecture

```
src/
  index.ts                  entrypoint: config -> clients -> strategy -> monitor loop

  config.ts                 environment configuration

  blockchain/               RPC, wallet, tx signing/sending/receipts
    client.ts
    wallet.ts

  uniswap/                  Uniswap V3 contracts & math (pool, NPM, quoter, router)
    abis.ts                 minimal hand-picked ABIs
    pool.ts                 pool metadata + slot0 state
    position.ts             read / decrease / collect / mint positions
    swap.ts                 quote + balancing-swap planning + SwapRouter02 call

  strategy/                 PURE logic — no blockchain code. Replace this.
    rebalance.ts            Strategy interface + range-center helpers
    centeredRange.ts        CenteredRangeStrategy implementation

  bot/
    monitor.ts              polling loop, per-cycle logging, trigger decision
    rebalanceExecutor.ts    plan-then-execute rebalance lifecycle

  utils/
    ticks.ts                tick alignment to tickSpacing
    math.ts                 TickMath / LiquidityAmounts ports (BigInt)
    logger.ts               structured JSON logs
```

Layer rules:

* **Strategy layer** is pure: given a current tick it decides *whether* to
  rebalance and *what range* to use. Swap `CenteredRangeStrategy` for a
  `VolatilityStrategy`, `GridStrategy`, etc. by implementing the `Strategy`
  interface (`src/strategy/rebalance.ts`) — nothing else changes.
* **Uniswap layer** knows contracts but not strategy.
* **Blockchain layer** knows RPC/wallets but not Uniswap.

## Rebalance lifecycle

```
MONITOR → CHECK REBALANCE → COLLECT FEES → REMOVE LIQUIDITY
        → DETERMINE BALANCES → OPTIONAL SWAP → CALCULATE NEW RANGE
        → MINT NEW POSITION → MONITOR ...
```

Every step re-reads state from the chain, so a failed rebalance (e.g. remove
liquidity succeeded but the swap failed) is recovered automatically: the next
cycle sees an empty position plus wallet balances and completes the lifecycle.

## Strategy: centered range

The new position is centered around the current pool tick:

```
lowerTick = alignDown(currentTick - RANGE_WIDTH_TICKS)
upperTick = alignUp(currentTick + RANGE_WIDTH_TICKS)
```

Ticks are aligned to the pool's `tickSpacing`. Rebalancing triggers when:

```
abs(currentTick - centerOfCurrentPosition) >= REBALANCE_THRESHOLD_TICKS
```

Because each new position is centered on the current tick, the distance resets
to ~0 after every rebalance — built-in hysteresis. The threshold must be
smaller than the width (validated at startup).

## Installation

```bash
npm install
cp .env.example .env   # then edit .env
```

Requires Node.js 20+.

## Configuration

| Variable | Description |
| --- | --- |
| `RPC_URL` | Base JSON-RPC endpoint(s); comma-separated list enables failover |
| `PRIVATE_KEY` | Wallet key (**never commit; use a dedicated hot wallet**) |
| `POOL_ADDRESS` | Any Uniswap V3 pool on Base |
| `POSITION_ID` | The NFT token id of the position to manage (initial value) |
| `STATE_FILE` | Local file tracking the managed position id across restarts/rebalances (default `state.json`) |
| `WALLET_ADDRESS` | Optional; defaults to the address derived from the key |
| `RANGE_WIDTH_TICKS` | Half-width of the new range in ticks |
| `REBALANCE_THRESHOLD_TICKS` | Distance from center that triggers a rebalance |
| `SLIPPAGE_BPS` | Slippage tolerance in basis points (100 = 1%) |
| `POLL_INTERVAL_SECONDS` | Monitoring loop interval |
| `DRY_RUN` | `true` = never send transactions |
| `POSITION_MANAGER_ADDRESS` / `SWAP_ROUTER_ADDRESS` / `QUOTER_ADDRESS` | Optional overrides; defaults are the official Base deployments |

Token addresses, decimals, ordering (`token0`/`token1`), fee and tick spacing
are always read from the chain — nothing about USDC/WETH is hard-coded.

### Position tracking

After each successful rebalance the bot writes the new position NFT id to
`STATE_FILE`. On startup the state file takes precedence over `POSITION_ID`,
so the bot automatically follows its own position. Delete the state file to
re-bind to a different position. The chain remains the source of truth for
everything else.

### RPC failover

Set several endpoints to survive provider outages:

```text
RPC_URL=https://mainnet.base.org,https://base.publicnode.com
```

Requests fail over automatically; the first healthy endpoint answers.

### Failure handling

A failed cycle (e.g. a reverting transaction) backs off exponentially —
poll interval doubling per consecutive failure, capped at 15 minutes — so a
persistent failure does not burn gas on every poll. The counter resets on the
next successful cycle.

Example `.env` for WETH/USDC 0.05% on Base:

```text
RPC_URL=https://mainnet.base.org
PRIVATE_KEY=0x...
POOL_ADDRESS=0xd0b53D9277642d899DF5C87A3966A349A798F224
POSITION_ID=42
RANGE_WIDTH_TICKS=1200
REBALANCE_THRESHOLD_TICKS=600
SLIPPAGE_BPS=100
POLL_INTERVAL_SECONDS=30
DRY_RUN=true
```

## Dry-run mode

```bash
DRY_RUN=true npm start
```

The bot reads pool state and your position, computes the proposed range,
required amounts and any swap, and logs exactly which transactions **would**
be sent (`[DRY RUN] Would ...`). No transaction is ever broadcast.

## Running against Base

1. Fund a dedicated wallet with both pool tokens (and a little ETH for gas).
2. Open one Uniswap V3 position in the target pool (e.g. via the Uniswap
   interface) and note its NFT token id.
3. Set `POSITION_ID` and configure the strategy parameters.
4. Test first with `DRY_RUN=true`.
5. Go live:

```bash
DRY_RUN=false npm start
```

Run it under a process manager (systemd, pm2, tmux) for continuous operation.

## Safety notes

* Configurable slippage on swaps and mint minimums.
* Every transaction is simulated (`eth_call`) before signing, and its receipt
  status is verified after mining.
* Never spends more than the wallet's token balances; never touches native ETH
  beyond gas.
* Fails loudly on reverted transactions; state is always recoverable from the
  chain.

This is experimental software. Auditing, key hygiene (dedicated hot wallet,
limited funds), and monitoring are your responsibility. Use at your own risk.

## Development

```bash
npm run typecheck        # tsc --noEmit
npm test                 # vitest unit tests (math, ticks, strategy)
npm run test:integration # fork integration tests (requires anvil, see below)
```

Unit tests cover TickMath/LiquidityAmounts ports, tick alignment, rebalance
triggering/hysteresis, and token-balancing logic.

### Fork integration tests

The integration suite runs the **full rebalance lifecycle** (mint → close →
collect → swap → mint) against a local Base fork using real contracts:

```bash
# 1. Start a fork (requires Foundry: https://getfoundry.sh)
anvil --fork-url https://base.publicnode.com

# 2. Run the suite in another terminal
FORK_URL=http://localhost:8545 npm run test:integration
```

The tests fund an anvil test account with WETH (via `deposit`) and USDC
(impersonating the pool itself, which holds both tokens), open an off-center
position through the real NonfungiblePositionManager, then let
`RebalanceExecutor` rebalance it. They verify the old position is closed, the
state file tracks the new position id, and the new position is centered near
the current tick. Without `FORK_URL` the suite is skipped automatically.

## References

* [Uniswap V3 Base deployments](https://developers.uniswap.org/docs/protocols/v3/deployments/v3-base-deployments)
* [NonfungiblePositionManager](https://github.com/Uniswap/v3-periphery/blob/main/contracts/NonfungiblePositionManager.sol)
* [SwapRouter02](https://github.com/Uniswap/swap-router-contracts)

MIT
