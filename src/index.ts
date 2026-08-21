import { loadConfig } from "./config.js";
import { createClient } from "./blockchain/client.js";
import { createTransactor } from "./blockchain/wallet.js";
import { getPoolInfo } from "./uniswap/pool.js";
import { CenteredRangeStrategy } from "./strategy/centeredRange.js";
import { Monitor } from "./bot/monitor.js";
import { ensureStateDir, loadPositionId } from "./bot/state.js";
import { logger } from "./utils/logger.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const client = createClient(config.rpcUrls);
  const transactor = createTransactor(config.privateKey, config.rpcUrls);

  // The state file tracks the position id across restarts and rebalances;
  // it takes precedence over POSITION_ID when present.
  ensureStateDir(config.stateFile);
  const statePositionId = loadPositionId(config.stateFile);
  if (statePositionId !== null) {
    logger.info("Resuming managed position from state file", {
      positionId: statePositionId.toString(),
      stateFile: config.stateFile,
    });
    config.positionId = statePositionId;
  }

  logger.info("Connecting to pool", { pool: config.poolAddress });
  const pool = await getPoolInfo(client, config.poolAddress);
  logger.info("Pool metadata read from chain", {
    token0: `${pool.token0.symbol} (${pool.token0.address}, ${pool.token0.decimals} decimals)`,
    token1: `${pool.token1.symbol} (${pool.token1.address}, ${pool.token1.decimals} decimals)`,
    fee: pool.fee,
    tickSpacing: pool.tickSpacing,
  });

  const strategy = new CenteredRangeStrategy({
    widthTicks: config.rangeWidthTicks,
    thresholdTicks: config.rebalanceThresholdTicks,
  });

  const monitor = new Monitor(client, transactor, config, pool, strategy);
  await monitor.run();
}

main().catch((error) => {
  logger.error("Fatal error", { error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
