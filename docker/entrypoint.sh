#!/bin/sh
# Container entrypoint for the LP re-centring bot.
#
# Refreshes the regime seed window, states what is about to run, then execs the
# bot as PID 1's child so signals reach it.

set -eu

log() { printf '%s\n' "$*" >&2; }

# A misconfiguration cannot be fixed by trying again, but `restart:
# unless-stopped` will try anyway. Pause before exiting so the failure is
# readable instead of a flood, and say what to actually do about it.
CONFIG_ERROR_PAUSE="${CONFIG_ERROR_PAUSE:-30}"
die_config() {
  log "error: $1"
  shift
  for line in "$@"; do log "       $line"; done
  log ""
  log "This is a configuration error; restarting will not fix it."
  log "Edit .env, then apply it with:  docker compose up -d --force-recreate"
  log "(\`docker compose restart\` reuses the old environment.)"
  log "Pausing ${CONFIG_ERROR_PAUSE}s so this does not spin."
  sleep "$CONFIG_ERROR_PAUSE"
  exit 1
}

: "${REGIME_MAX_MOVE_PCT:=0}"
: "${LP_REGIME_LOOKBACK_HOURS:=168}"
: "${LP_SEED_FILE:=/app/state/seed-5m.csv}"
: "${SEED_DAYS:=30}"
: "${FETCH_SEED:=1}"

[ -n "${RPC_URL:-}" ]      || die_config "RPC_URL is not set" "Set it in .env."
[ -n "${POOL_ADDRESS:-}" ] || die_config "POOL_ADDRESS is not set" "Set it in .env."

if [ "${DRY_RUN:-true}" = "false" ]; then
  [ -n "${PRIVATE_KEY:-}" ] ||
    die_config "DRY_RUN=false requires PRIVATE_KEY" "Set PRIVATE_KEY in .env."

  if [ "${LIVE_CONFIRM:-}" != "yes" ]; then
    die_config \
      "DRY_RUN=false requires LIVE_CONFIRM=yes (currently '${LIVE_CONFIRM:-<empty>}')." \
      "There is no prompt in a container, so setting BOTH is the deliberate" \
      "act of authorising real transactions." \
      "" \
      "Add this line to .env:" \
      "    LIVE_CONFIRM=yes" \
      "" \
      "Or go back to a dry run with:" \
      "    DRY_RUN=true"
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
    # Skip the download when the existing seed is still fresh. Without this a
    # crash loop re-downloads ~9000 rows from Binance on every restart, which
    # hammers them for no benefit and buries the actual error in the log.
    SEED_FRESH=0
    if [ -f "$LP_SEED_FILE" ]; then
      SEED_AGE=$(( $(date +%s) - $(stat -c %Y "$LP_SEED_FILE" 2>/dev/null || echo 0) ))
      if [ "$SEED_AGE" -lt "${SEED_MAX_AGE_SECONDS:-3600}" ]; then
        SEED_FRESH=1
        log "Seed is ${SEED_AGE}s old; reusing it"
      fi
    fi

    if [ "$FETCH_SEED" = "1" ] && [ "$SEED_FRESH" = "0" ]; then
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
    elif [ "$FETCH_SEED" != "1" ]; then
      log "FETCH_SEED=0: not refreshing the seed"
    fi
    log "Regime filter: stand aside above ${REGIME_MAX_MOVE_PCT}% over ${LP_REGIME_LOOKBACK_HOURS}h"
    ;;
esac

log "Starting lp-live"
exec ./node_modules/.bin/tsx src/index.ts "$@"
