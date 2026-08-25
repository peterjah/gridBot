import { createClient } from "../blockchain/client.js";
import { createTransactor, type Transactor } from "../blockchain/wallet.js";
import { getPoolInfo } from "../uniswap/pool.js";
import { CenteredRangeStrategy } from "../strategy/centeredRange.js";
import { Monitor } from "../bot/monitor.js";
import { ensureStateDir, loadState, saveState, seedPriceHistory } from "../bot/state.js";
import { loadPrices } from "./backtest.js";
import type { AppConfig } from "../config.js";
import { logger } from "../utils/logger.js";

/**
 * Live Uniswap V3 LP re-centring.
 *
 * Holds one concentrated position around the current price and re-centres it
 * when price drifts past the configured threshold. This is the on-chain
 * counterpart of the passive-LP backtest in `src/lp/passiveLp.ts`: same range
 * width, same trigger buffer, same cooldown, so a configuration selected by
 * `npm run lp` can be deployed unchanged.
 *
 * Unlike the grid runner, the bot never places its own buy/sell orders — the
 * pool executes them, and the bot collects the fee income instead of paying it.
 *
 * Defaults to DRY_RUN=true. Broadcasting requires DRY_RUN=false *and*
 * LIVE_CONFIRM=yes.
 */
export async function runLpLiveMode(cfg: AppConfig): Promise<void> {
  const lp = cfg.lpRebalance;

  if (!lp.dryRun && process.env.LIVE_CONFIRM !== "yes") {
    throw new Error(
      "Refusing to start: broadcasting requires LIVE_CONFIRM=yes (or set DRY_RUN=true)",
    );
  }

  const client = createClient(cfg.rpcUrls);
  const pool = await getPoolInfo(client, cfg.poolAddress!);

  const strategy = new CenteredRangeStrategy({
    widthTicks: lp.widthTicks,
    thresholdTicks: lp.thresholdTicks,
  });

  // In dry-run the transactor is never asked to send, so a wallet address is
  // enough to plan against. Anything that would broadcast needs a real key.
  let transactor: Transactor;
  if (cfg.privateKey) {
    transactor = createTransactor(cfg.privateKey, cfg.rpcUrls);
  } else if (lp.dryRun && cfg.walletAddress) {
    transactor = readOnlyTransactor(cfg.walletAddress);
  } else {
    throw new Error("lp-live needs PRIVATE_KEY, or DRY_RUN=true with WALLET_ADDRESS set");
  }

  ensureStateDir(lp.stateFile);

  // Seed the regime window from history so the filter is not blind for its
  // whole lookback on a fresh deployment.
  if (lp.regimeMaxMovePct > 0 && lp.seedFile) {
    try {
      const history = await loadPrices(lp.seedFile, null, 0);
      const state = loadState(lp.stateFile);
      const seeded = seedPriceHistory(
        state,
        history.map((point) => ({ t: point.timestamp, p: point.price })),
        Math.floor(Date.now() / 1000),
        lp.regimeLookbackHours * 3600,
        lp.regimeSampleMinutes * 60,
      );
      saveState(lp.stateFile, state);
      logger.info("Seeded regime price history", {
        seedFile: lp.seedFile,
        samples: seeded,
        lookbackHours: lp.regimeLookbackHours,
      });
      if (seeded === 0) {
        logger.warn(
          "Seed file covers none of the lookback window — the regime filter " +
            "will stay inactive until live samples fill it. Refresh the CSV " +
            "(npm run fetch-data) or accept the exposure.",
        );
      } else {
        // A seed that stops days before now leaves a hole in the middle of the
        // window, so the trailing move is measured across data the bot does
        // not have. Warn in proportion to the hole.
        const newest = state.priceHistory[state.priceHistory.length - 1]?.t ?? 0;
        const staleHours = (Date.now() / 1000 - newest) / 3600;
        if (staleHours > lp.regimeLookbackHours * 0.1) {
          logger.warn("Seed data is stale — regime window has a gap", {
            staleHours: staleHours.toFixed(1),
            lookbackHours: lp.regimeLookbackHours,
            gapPercent: ((staleHours / lp.regimeLookbackHours) * 100).toFixed(0),
            fix: "npm run fetch-data",
          });
        }
      }
    } catch (error) {
      logger.warn("Could not seed regime history; filter starts blind", {
        seedFile: lp.seedFile,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  logger.info("LP re-centring configuration", {
    rangePct: lp.rangePct,
    recenterBufferPct: lp.recenterBufferPct,
    widthTicks: lp.widthTicks,
    thresholdTicks: lp.thresholdTicks,
    recenterMinHours: lp.recenterMinHours,
    slippageBps: lp.slippageBps,
    tickSpacing: pool.tickSpacing,
    regimeMaxMovePct: lp.regimeMaxMovePct,
    regimeLookbackHours: lp.regimeLookbackHours,
    regimeSampleMinutes: lp.regimeSampleMinutes,
    dryRun: lp.dryRun,
  });

  if (lp.regimeMaxMovePct > 0 && !lp.seedFile) {
    logger.warn(
      `No seed file (LP_SEED_FILE / --lp-seed-file). The regime filter stays ` +
        `inactive until ${lp.regimeLookbackHours}h of live samples accumulate, ` +
        `and the position is fully exposed until then.`,
    );
  }

  if (lp.regimeMaxMovePct <= 0) {
    logger.warn(
      "Regime filter is OFF. Walk-forward on this strategy loses money in 3 of " +
        "4 out-of-sample folds without it; the filter cut the worst fold from " +
        "-29.7% to about -10%. See docs/LP_REBALANCE.md.",
    );
  }

  const monitor = new Monitor(
    client,
    transactor,
    lp,
    cfg.walletAddress,
    cfg.pollIntervalSeconds,
    pool,
    strategy,
  );
  await monitor.run();
}

/** A transactor that can plan but refuses to sign. Dry-run only. */
function readOnlyTransactor(address: `0x${string}`): Transactor {
  return {
    account: { address } as Transactor["account"],
    walletClient: null as unknown as Transactor["walletClient"],
    async send() {
      throw new Error("Read-only transactor: set PRIVATE_KEY to broadcast");
    },
  };
}
