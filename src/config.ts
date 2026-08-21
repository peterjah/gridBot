import "dotenv/config";

export interface Config {
  rpcUrls: string[];
  privateKey: `0x${string}`;
  walletAddress: `0x${string}` | undefined;
  poolAddress: `0x${string}`;
  positionId: bigint;
  rangeWidthTicks: number;
  rebalanceThresholdTicks: number;
  slippageBps: number;
  pollIntervalSeconds: number;
  dryRun: boolean;
  stateFile: string;
  positionManagerAddress: `0x${string}`;
  swapRouterAddress: `0x${string}`;
  quoterAddress: `0x${string}`;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function requireIntEnv(name: string): number {
  const value = Number.parseInt(requireEnv(name), 10);
  if (Number.isNaN(value)) {
    throw new Error(`Environment variable ${name} must be an integer`);
  }
  return value;
}

function optionalAddressEnv(name: string, fallback: `0x${string}`): `0x${string}` {
  const value = process.env[name];
  if (!value || value.length === 0) return fallback;
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error(`Environment variable ${name} is not a valid address`);
  }
  return value.toLowerCase() as `0x${string}`;
}

export function loadConfig(): Config {
  const privateKey = requireEnv("PRIVATE_KEY");
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new Error("PRIVATE_KEY must be a 32-byte hex string prefixed with 0x");
  }

  const slippageBps = requireIntEnv("SLIPPAGE_BPS");
  if (slippageBps < 0 || slippageBps > 5000) {
    throw new Error("SLIPPAGE_BPS must be between 0 and 5000");
  }

  return {
    rpcUrls: requireEnv("RPC_URL")
      .split(",")
      .map((url) => url.trim())
      .filter((url) => url.length > 0),
    privateKey: privateKey as `0x${string}`,
    walletAddress: process.env.WALLET_ADDRESS
      ? (process.env.WALLET_ADDRESS.toLowerCase() as `0x${string}`)
      : undefined,
    poolAddress: requireEnv("POOL_ADDRESS").toLowerCase() as `0x${string}`,
    positionId: BigInt(requireIntEnv("POSITION_ID")),
    rangeWidthTicks: requireIntEnv("RANGE_WIDTH_TICKS"),
    rebalanceThresholdTicks: requireIntEnv("REBALANCE_THRESHOLD_TICKS"),
    slippageBps,
    pollIntervalSeconds: requireIntEnv("POLL_INTERVAL_SECONDS"),
    dryRun: (process.env.DRY_RUN ?? "false").toLowerCase() === "true",
    stateFile: process.env.STATE_FILE ?? "state.json",
    // Official Uniswap V3 deployments on Base (chain id 8453)
    positionManagerAddress: optionalAddressEnv(
      "POSITION_MANAGER_ADDRESS",
      "0x03a520b32c04bf3beef7beb72e919cf822ed34f1",
    ),
    swapRouterAddress: optionalAddressEnv(
      "SWAP_ROUTER_ADDRESS",
      "0x2626664c2603336e57b271c5c0b26f421741e481",
    ),
    quoterAddress: optionalAddressEnv(
      "QUOTER_ADDRESS",
      "0x3d4e44eb1374240ce5f1b871ab261cd16335b76a",
    ),
  };
}
