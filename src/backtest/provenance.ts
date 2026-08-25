import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

/**
 * Everything needed to reproduce a number, captured at run time.
 *
 * A result is only auditable if the record answers: which code, which data,
 * which settings. Storing the strategy parameters alone is not enough — two
 * runs with an identical parameter spec produced returns 4.4x apart because
 * the fee model changed between them and nothing recorded that.
 */
export interface Provenance {
  /** Exact argv the process was invoked with. */
  command: string;
  /** Environment variables that can change a result. */
  env: Record<string, string>;
  /** Dataset identity, so a silently regenerated file is detectable. */
  datasets: DatasetFingerprint[];
  /** Code identity, so pre-/post-fix runs can never be confused. */
  code: CodeFingerprint;
  /** Which income sources were active — the single biggest result driver. */
  income: {
    lpFeeIncome: boolean;
    lpCalibration: "measured-apr-series" | "constant-apr" | "volume-share" | "none";
    lendingYield: boolean;
  };
  ranAt: string;
  nodeVersion: string;
}

export interface DatasetFingerprint {
  role: "prices" | "apr";
  path: string;
  bytes: number;
  sha256: string;
  rows: number;
  firstTimestamp: number | null;
  lastTimestamp: number | null;
}

export interface CodeFingerprint {
  /** git HEAD, or "unknown" outside a repo. */
  commit: string;
  /** true when tracked files differ from HEAD — the usual case mid-work. */
  dirty: boolean;
  /** Hash of every .ts file under src/, which is what actually ran. */
  srcSha256: string;
}

/** Env vars that can move a number. Anything else is presentation only. */
const RESULT_AFFECTING_ENV = [
  "INITIAL_USDC", "INITIAL_ETH", "GRID_CENTER_PRICE", "GRID_SPACING_PERCENT",
  "GRID_LEVELS_ABOVE", "GRID_LEVELS_BELOW", "ORDER_SIZE_USD",
  "SWAP_FEE_BPS", "SLIPPAGE_BPS", "ESTIMATED_GAS_USD",
  "GAS_TX_OVERHEAD_USD", "GAS_PER_FILL_USD", "GAS_LENDING_LEG_USD", "GAS_LENDING_LEGS",
  "MIN_ETH_USD", "MAX_ETH_USD",
  "GRID_RESET_BUFFER_LEVELS", "RESET_BUFFER_SPACINGS", "GRID_REGEN_MIN_SECONDS",
  "GRID_VOL_LOOKBACK", "GRID_MAX_VOL_PER_STEP",
  "GRID_BREAKER_RESETS", "GRID_BREAKER_WINDOW_SECONDS",
  "RESET_SELL_FRACTION", "RESET_UNDERWATER_SKIP_PCT", "RESET_SKIP_COOLDOWN_WHEN_FLAT",
  "RESET_CONFIRM_OBSERVATIONS", "RESET_VOL_POSTPONE",
  "RESET_HARD_DRAWDOWN_PCT", "RESET_HARD_INVENTORY_LOSS_PCT",
  "LP_FEE_BPS", "LP_VENUE_VOLUME_SHARE_PCT", "LP_POOL_LIQUIDITY_USD",
  "LP_FEE_APR_PCT", "LP_REFERENCE_RANGE_PCT", "LP_APR_FILE", "LP_MIN_POOL_TVL_USD",
  "REGIME_MAX_MOVE_PCT", "REGIME_LOOKBACK_POINTS",
  "CSV_FILE", "ENABLE_AAVE", "LEND_BUFFER_USDC", "LEND_BUFFER_ETH",
];

function sha256(buf: Buffer | string): string {
  return createHash("sha256").update(buf).digest("hex").slice(0, 16);
}

export function fingerprintDataset(
  path: string,
  role: DatasetFingerprint["role"],
): DatasetFingerprint {
  const raw = readFileSync(path);
  const text = raw.toString("utf8");
  const lines = text.split("\n").filter((l) => l.trim() && !l.startsWith("#"));
  const body = lines.slice(/timestamp|date/i.test(lines[0] ?? "") ? 1 : 0);

  const stamp = (line: string | undefined): number | null => {
    if (!line) return null;
    const first = line.split(",")[0]!;
    if (/^\d+$/.test(first)) return Number(first);
    const parsed = Date.parse(first);
    return Number.isNaN(parsed) ? null : Math.floor(parsed / 1000);
  };

  return {
    role,
    path,
    bytes: statSync(path).size,
    sha256: sha256(raw),
    rows: body.length,
    firstTimestamp: stamp(body[0]),
    lastTimestamp: stamp(body[body.length - 1]),
  };
}

export function fingerprintCode(): CodeFingerprint {
  const git = (args: string[]): string | null => {
    try {
      return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return null;
    }
  };
  const commit = git(["rev-parse", "HEAD"]) ?? "unknown";
  const status = git(["status", "--porcelain"]);

  // Hash the source that actually ran. The working tree is usually dirty, so
  // the commit alone does not identify the behaviour under test — this does.
  const files = (git(["ls-files", "-co", "--exclude-standard", "src"]) ?? "")
    .split("\n")
    .filter((f) => f.endsWith(".ts"))
    .sort();
  const hash = createHash("sha256");
  for (const file of files) {
    try {
      hash.update(file);
      hash.update(readFileSync(file));
    } catch {
      // A file listed but unreadable simply does not contribute.
    }
  }

  return {
    commit,
    dirty: status !== null && status.length > 0,
    srcSha256: hash.digest("hex").slice(0, 16),
  };
}

export function captureProvenance(opts: {
  pricesFile: string;
  aprFile?: string | null;
  lpFeeIncomeActive: boolean;
  lpCalibration: Provenance["income"]["lpCalibration"];
  lendingYield: boolean;
}): Provenance {
  const env: Record<string, string> = {};
  for (const key of RESULT_AFFECTING_ENV) {
    const value = process.env[key];
    if (value !== undefined && value !== "") env[key] = value;
  }

  const datasets = [fingerprintDataset(opts.pricesFile, "prices")];
  if (opts.aprFile) datasets.push(fingerprintDataset(opts.aprFile, "apr"));

  return {
    command: ["npm run", process.env["npm_lifecycle_event"] ?? "?", "--", ...process.argv.slice(2)]
      .join(" ")
      .trim(),
    env,
    datasets,
    code: fingerprintCode(),
    income: {
      lpFeeIncome: opts.lpFeeIncomeActive,
      lpCalibration: opts.lpCalibration,
      lendingYield: opts.lendingYield,
    },
    ranAt: new Date().toISOString(),
    nodeVersion: process.version,
  };
}
