/**
 * Should undeployed capital trigger a re-centre?
 *
 * The bot only moves capital at transitions — park, re-enter, re-centre — so
 * anything deposited while a position sits quietly at its centre waits for the
 * next one. With a 723-tick trigger and a 24h cooldown that can be weeks, and
 * meanwhile the money earns a money-market rate instead of pool fees. Observed
 * live: 0.14 WETH sat in Aave while the LP held everything else.
 *
 * A re-centre already withdraws everything and redeploys, so absorbing a
 * deposit needs no new machinery — only another reason to re-centre.
 *
 * PURE: no chain, no clock.
 */

export interface IdleCapitalInputs {
  /** Undeployed value: wallet balances plus anything supplied to Aave, USD. */
  idleUsd: number;
  /** Value currently deployed as liquidity, USD. */
  deployedUsd: number;
  /** Redeploy once idle reaches this percent of the deployed position. */
  thresholdPct: number;
  /**
   * Absolute floor, USD. A percentage alone would churn a small position on
   * dust: minting never consumes the wallet exactly, so a few cents of
   * leftover against a tiny position can exceed any percentage.
   */
  minUsd: number;
}

export interface IdleCapitalDecision {
  redeploy: boolean;
  idlePct: number;
  reason: string;
}

export function shouldRedeployIdle(input: IdleCapitalInputs): IdleCapitalDecision {
  const { idleUsd, deployedUsd, thresholdPct, minUsd } = input;

  // Disabled, or nothing to redeploy.
  if (!(thresholdPct > 0)) {
    return { redeploy: false, idlePct: 0, reason: "idle redeploy disabled" };
  }
  if (!(idleUsd > 0)) {
    return { redeploy: false, idlePct: 0, reason: "no idle capital" };
  }

  // Both gates must pass. The floor stops dust churning a small position; the
  // percentage stops a trivial top-up churning a large one.
  if (idleUsd < minUsd) {
    return {
      redeploy: false,
      idlePct: deployedUsd > 0 ? (idleUsd / deployedUsd) * 100 : Infinity,
      reason: `idle $${idleUsd.toFixed(2)} below the $${minUsd} floor`,
    };
  }

  // Nothing deployed: any idle capital above the floor should be put to work,
  // and a percentage of zero is meaningless.
  if (!(deployedUsd > 0)) {
    return { redeploy: true, idlePct: Infinity, reason: "nothing deployed" };
  }

  const idlePct = (idleUsd / deployedUsd) * 100;
  return idlePct >= thresholdPct
    ? {
        redeploy: true,
        idlePct,
        reason: `idle ${idlePct.toFixed(1)}% of the position (>= ${thresholdPct}%)`,
      }
    : {
        redeploy: false,
        idlePct,
        reason: `idle ${idlePct.toFixed(1)}% below ${thresholdPct}%`,
      };
}
