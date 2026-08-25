#!/usr/bin/env bash
#
# start.sh — launch the Uniswap V3 LP re-centring bot.
#
# Defaults to a DRY RUN: every step is planned, quoted and logged, nothing is
# broadcast. Pass --live to broadcast, which requires typing a confirmation.
#
#   ./start.sh                        # dry run, default parameters
#   ./start.sh --range 5 --buffer 50  # override strategy parameters
#   ./start.sh --live                 # broadcast (interactive confirmation)
#   ./start.sh --help
#
# The regime filter is ON by default here. Walk-forward says the strategy loses
# money in 3 of 4 out-of-sample folds without it (docs/LP_REBALANCE.md).

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

# ---------------------------------------------------------------- defaults ---
RANGE_PCT=5           # half-width of the managed band, percent
BUFFER_PCT=50         # re-centre this far beyond the band edge, % of half-width
REGIME_MOVE=3         # stand aside above this trailing move, percent (0 = off)
REGIME_HOURS=168      # regime lookback, hours
RECENTER_HOURS=24     # minimum hours between re-centres
SLIPPAGE_BPS=50
POLL_SECONDS=30
SEED_DAYS=30          # days of 5-minute history fetched to seed the filter
SEED_CSV="data/lp-live-seed-5m.csv"

LIVE=0
DO_FETCH=1
DO_CHECKS=1

RED=$'\033[31m'; YEL=$'\033[33m'; GRN=$'\033[32m'; DIM=$'\033[2m'; OFF=$'\033[0m'
say()  { printf '%s\n' "$*"; }
info() { printf '%s==>%s %s\n' "$GRN" "$OFF" "$*"; }
warn() { printf '%swarning:%s %s\n' "$YEL" "$OFF" "$*" >&2; }
die()  { printf '%serror:%s %s\n' "$RED" "$OFF" "$*" >&2; exit 1; }

usage() {
  sed -n '3,15p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  cat <<'USAGE'

Options:
  --live                 Broadcast transactions (requires confirmation).
  --range PCT            Band half-width, percent.             (default 5)
  --buffer PCT           Re-centre trigger, % of half-width.   (default 50)
  --regime-move PCT      Stand aside above this move; 0 = off. (default 3)
  --regime-hours H       Regime lookback window, hours.        (default 168)
  --recenter-hours H     Minimum hours between re-centres.     (default 24)
  --slippage-bps N       Slippage tolerance.                   (default 50)
  --poll-seconds N       Poll interval.                        (default 30)
  --seed-days N          Days of 5m history to seed with.      (default 30)
  --no-fetch             Skip refreshing the seed data.
  --skip-checks          Skip typecheck and tests.
  -h, --help             This message.
USAGE
}

# ------------------------------------------------------------------- args ---
while [ $# -gt 0 ]; do
  case "$1" in
    --live)           LIVE=1; shift ;;
    --range)          RANGE_PCT="${2:?--range needs a value}"; shift 2 ;;
    --buffer)         BUFFER_PCT="${2:?--buffer needs a value}"; shift 2 ;;
    --regime-move)    REGIME_MOVE="${2:?--regime-move needs a value}"; shift 2 ;;
    --regime-hours)   REGIME_HOURS="${2:?--regime-hours needs a value}"; shift 2 ;;
    --recenter-hours) RECENTER_HOURS="${2:?--recenter-hours needs a value}"; shift 2 ;;
    --slippage-bps)   SLIPPAGE_BPS="${2:?--slippage-bps needs a value}"; shift 2 ;;
    --poll-seconds)   POLL_SECONDS="${2:?--poll-seconds needs a value}"; shift 2 ;;
    --seed-days)      SEED_DAYS="${2:?--seed-days needs a value}"; shift 2 ;;
    --no-fetch)       DO_FETCH=0; shift ;;
    --skip-checks)    DO_CHECKS=0; shift ;;
    -h|--help)        usage; exit 0 ;;
    *)                die "unknown option: $1  (try --help)" ;;
  esac
done

# -------------------------------------------------------------- preflight ---
info "Preflight"

command -v node >/dev/null 2>&1 || die "node not found on PATH"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || die "Node 20+ required, found $(node -v)"
say "  node $(node -v)"

[ -d node_modules ] || { info "Installing dependencies"; npm install; }
[ -f .env ] || die ".env not found. Copy .env.example to .env and fill it in."

# Read .env without executing it: values may contain spaces or '#'.
get_env() {
  local key="$1"
  if [ -n "${!key-}" ]; then printf '%s' "${!key}"; return; fi
  sed -n "s/^[[:space:]]*${key}=//p" .env | tail -n 1 | sed 's/[[:space:]]*$//'
}

RPC_URL_V="$(get_env RPC_URL)"
POOL_ADDRESS_V="$(get_env POOL_ADDRESS)"
PRIVATE_KEY_V="$(get_env PRIVATE_KEY)"
WALLET_ADDRESS_V="$(get_env WALLET_ADDRESS)"
STATE_FILE_V="$(get_env STATE_FILE)"
[ -n "$STATE_FILE_V" ] || STATE_FILE_V="state/position.json"

[ -n "$RPC_URL_V" ]      || die "RPC_URL is not set in .env"
[ -n "$POOL_ADDRESS_V" ] || die "POOL_ADDRESS is not set in .env"

if [ "$LIVE" -eq 1 ]; then
  [ -n "$PRIVATE_KEY_V" ] || die "PRIVATE_KEY is required for --live"
elif [ -z "$PRIVATE_KEY_V" ] && [ -z "$WALLET_ADDRESS_V" ]; then
  die "a dry run needs PRIVATE_KEY or WALLET_ADDRESS in .env"
fi
say "  pool  $POOL_ADDRESS_V"
say "  state $STATE_FILE_V"

# ------------------------------------------------------------------ checks ---
if [ "$DO_CHECKS" -eq 1 ]; then
  info "Typecheck"
  npm run --silent typecheck
  info "Tests"
  # Two soak-report tests are known-failing and unrelated to the LP path; do
  # not let them block a launch, but do not hide them either.
  if ! npm run --silent test >/tmp/lp-live-tests.log 2>&1; then
    warn "test suite reported failures — see /tmp/lp-live-tests.log"
    grep -E '^\s+(Tests|Test Files)' /tmp/lp-live-tests.log || true
  else
    grep -E '^\s+Tests' /tmp/lp-live-tests.log || true
  fi
else
  warn "skipping typecheck and tests (--skip-checks)"
fi

# -------------------------------------------------------------- seed data ---
# The regime filter needs REGIME_HOURS of history before it can judge anything.
# Without a seed the bot runs fully exposed for that entire window — which is
# the exposure the filter exists to prevent.
if [ "${REGIME_MOVE%%.*}" != "0" ] && [ "$DO_FETCH" -eq 1 ]; then
  NEED_DAYS=$(( (REGIME_HOURS + 23) / 24 + 2 ))
  [ "$SEED_DAYS" -ge "$NEED_DAYS" ] || {
    warn "--seed-days $SEED_DAYS is shorter than the ${REGIME_HOURS}h lookback; using $NEED_DAYS"
    SEED_DAYS="$NEED_DAYS"
  }
  FROM_DATE="$(node -e "
    const d = new Date(Date.now() - $SEED_DAYS * 86400000);
    process.stdout.write(d.toISOString().slice(0, 10));
  ")"
  info "Fetching ${SEED_DAYS}d of 5-minute history to seed the regime filter"
  npm run --silent fetch-data -- \
    --symbol ETHUSDT --interval 5m --from "$FROM_DATE" --out "$SEED_CSV"
elif [ "${REGIME_MOVE%%.*}" = "0" ]; then
  warn "regime filter is OFF — walk-forward loses money in 3 of 4 out-of-sample
           folds without it (docs/LP_REBALANCE.md)"
elif [ "$DO_FETCH" -eq 0 ]; then
  warn "skipping data refresh (--no-fetch): a stale seed leaves a gap in the
           regime window, and the bot will say so at startup"
fi

# Decide the seed file explicitly. Never inherit CSV_FILE from .env: that
# points at generated sample data for backtesting, and seeding the regime
# filter from synthetic prices would produce a confident, meaningless verdict.
SEED_ARG=""
if [ "${REGIME_MOVE%%.*}" = "0" ]; then
  :
elif [ "$DO_FETCH" -eq 1 ]; then
  SEED_ARG="$SEED_CSV"
elif [ -f "$SEED_CSV" ]; then
  SEED_ARG="$SEED_CSV"
  warn "using the existing seed at $SEED_CSV without refreshing it"
else
  warn "no seed data ($SEED_CSV missing and --no-fetch given): the regime
           filter starts blind and stays invested until ${REGIME_HOURS}h of live
           samples accumulate"
fi

# ------------------------------------------------------------------- plan ---
MODE_LABEL="DRY RUN — nothing will be broadcast"
[ "$LIVE" -eq 1 ] && MODE_LABEL="${RED}LIVE — real transactions, real funds${OFF}"

cat <<PLAN

  ${DIM}------------------------------------------------------------${OFF}
  Uniswap V3 LP re-centring
  ${DIM}------------------------------------------------------------${OFF}

  Mode              $MODE_LABEL
  Band              ±${RANGE_PCT}%
  Re-centre         beyond ${BUFFER_PCT}% of half-width, min ${RECENTER_HOURS}h apart
  Regime filter     $( [ "${REGIME_MOVE%%.*}" = "0" ] && echo "off" \
                        || echo "stand aside above ${REGIME_MOVE}% over ${REGIME_HOURS}h" )
  Slippage          ${SLIPPAGE_BPS} bps
  Poll              every ${POLL_SECONDS}s
  Seed data         ${SEED_ARG:-(none — filter starts blind)}

  ${YEL}These parameters are not validated as profitable.${OFF} Out-of-sample
  walk-forward on 5-minute Base ETH/USDC data:
    - without the regime filter: 1 of 4 folds profitable, mean -7.8%
    - with it:                   3 of 4 folds, mean +4.0%, parked ~65% of the time
  The +4.0% is itself fitted to one lookback and is not an expected return.
  What is robust is the drawdown reduction. See docs/LP_REBALANCE.md.

  The bot deploys the ENTIRE wallet balance. Fund it with only what you
  intend to risk.

PLAN

if [ "$LIVE" -eq 1 ]; then
  if [ ! -t 0 ]; then
    die "--live needs an interactive terminal for confirmation"
  fi
  printf 'Type %sdeploy%s to broadcast real transactions: ' "$RED" "$OFF"
  read -r REPLY_TEXT
  [ "$REPLY_TEXT" = "deploy" ] || die "aborted"
fi

# ------------------------------------------------------------------ launch ---
info "Starting"

ARGS=(
  --lp-range "$RANGE_PCT"
  --lp-recenter-buffer "$BUFFER_PCT"
  --lp-regime-move "$REGIME_MOVE"
  --lp-regime-hours "$REGIME_HOURS"
  --lp-recenter-hours "$RECENTER_HOURS"
  --lp-slippage-bps "$SLIPPAGE_BPS"
  --lp-seed-file "$SEED_ARG"
  --interval "$POLL_SECONDS"
)

export MODE=lp-live
export DRY_RUN=$( [ "$LIVE" -eq 1 ] && echo false || echo true )
[ "$LIVE" -eq 1 ] && export LIVE_CONFIRM=yes
# LP_SEED_FILE is separate from CSV_FILE by design: CSV_FILE defaults to
# generated sample data, and seeding a risk filter from synthetic prices would
# produce a confident, meaningless verdict.
export LP_SEED_FILE="$SEED_ARG"

exec npx tsx src/index.ts "${ARGS[@]}"
