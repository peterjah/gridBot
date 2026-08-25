#!/bin/sh
# Container entrypoint for the LP re-centring bot.
#
# Refreshes the regime seed window, states what is about to run, then execs the
# bot as PID 1's child so signals reach it.

set -eu

log() { printf '%s\n' "$*" >&2; }

: "${REGIME_MAX_MOVE_PCT:=0}"
: "${LP_REGIME_LOOKBACK_HOURS:=168}"
: "${LP_SEED_FILE:=/app/state/seed-5m.csv}"
: "${SEED_DAYS:=30}"
: "${FETCH_SEED:=1}"

if [ -z "${RPC_URL:-}" ];      then log "error: RPC_URL is not set";      exit 1; fi
if [ -z "${POOL_ADDRESS:-}" ]; then log "error: POOL_ADDRESS is not set"; exit 1; fi

if [ "${DRY_RUN:-true}" = "false" ]; then
  if [ -z "${PRIVATE_KEY:-}" ]; then
    log "error: DRY_RUN=false requires PRIVATE_KEY"
    exit 1
  fi
  if [ "${LIVE_CONFIRM:-}" != "yes" ]; then
    log "error: DRY_RUN=false requires LIVE_CONFIRM=yes."
    log "       There is no prompt in a container; setting both is the"
    log "       deliberate act of authorising real transactions."
    exit 1
  fi
  log "MODE: LIVE — real transactions, real funds"
else
  log "MODE: DRY RUN — nothing will be broadcast"
fi

# The regime filter needs its whole lookback of history before it can judge
# anything. Without a seed the bot runs fully exposed for that entire window,
# which is the exposure the filter exists to prevent.
case "$REGIME_MAX_MOVE_PCT" in
  0|0.0|"") log "Regime filter: OFF" ;;
  *)
    if [ "$FETCH_SEED" = "1" ]; then
      NEED_DAYS=$(( (LP_REGIME_LOOKBACK_HOURS + 23) / 24 + 2 ))
      [ "$SEED_DAYS" -ge "$NEED_DAYS" ] || SEED_DAYS="$NEED_DAYS"
      FROM=$(node -e "process.stdout.write(new Date(Date.now()-$SEED_DAYS*864e5).toISOString().slice(0,10))")
      log "Fetching ${SEED_DAYS}d of 5-minute history to seed the regime filter"
      # A failed fetch must not stop the bot: it starts blind and says so.
      # Resolve tsx from node_modules rather than npx, which would reach for
      # the network if the local copy were ever missing.
      ./node_modules/.bin/tsx scripts/fetchPrices.ts \
        --symbol "${SEED_SYMBOL:-ETHUSDT}" --interval 5m --from "$FROM" --out "$LP_SEED_FILE" \
        || log "warning: seed fetch failed; the regime filter will start blind"
    else
      log "FETCH_SEED=0: not refreshing the seed"
    fi
    log "Regime filter: stand aside above ${REGIME_MAX_MOVE_PCT}% over ${LP_REGIME_LOOKBACK_HOURS}h"
    ;;
esac

log "Starting lp-live"
exec ./node_modules/.bin/tsx src/index.ts "$@"
