import { describe, expect, it } from "vitest";
import { shouldRedeployIdle } from "../src/bot/idleCapital.js";
import type { IdleCapitalInputs } from "../src/bot/idleCapital.js";

const base: IdleCapitalInputs = {
  idleUsd: 0,
  deployedUsd: 10_000,
  thresholdPct: 5,
  minUsd: 50,
};
const at = (o: Partial<IdleCapitalInputs>) => shouldRedeployIdle({ ...base, ...o });

describe("shouldRedeployIdle", () => {
  it("does nothing without idle capital", () => {
    expect(at({ idleUsd: 0 }).redeploy).toBe(false);
  });

  it("is disabled by a zero threshold", () => {
    expect(at({ idleUsd: 9_999, thresholdPct: 0 }).redeploy).toBe(false);
  });

  it("redeploys once idle reaches the threshold share", () => {
    expect(at({ idleUsd: 500 }).redeploy).toBe(true); // 5% of 10k
    expect(at({ idleUsd: 501 }).redeploy).toBe(true);
  });

  it("holds just below the threshold", () => {
    expect(at({ idleUsd: 499 }).redeploy).toBe(false);
  });

  /**
   * Minting never consumes the wallet exactly. Against a small position a few
   * cents of leftover can exceed any percentage, so a floor is required or the
   * bot re-centres itself in a loop on its own dust.
   */
  it("ignores dust that clears the percentage but not the floor", () => {
    const d = at({ idleUsd: 20, deployedUsd: 100 }); // 20% but only $20
    expect(d.redeploy).toBe(false);
    expect(d.reason).toMatch(/floor/);
  });

  it("requires both gates, not either", () => {
    // Above the floor but a trivial share of a large position.
    expect(at({ idleUsd: 100, deployedUsd: 100_000 }).redeploy).toBe(false);
    // Above the share but below the floor.
    expect(at({ idleUsd: 40, deployedUsd: 200 }).redeploy).toBe(false);
    // Both.
    expect(at({ idleUsd: 6_000, deployedUsd: 100_000 }).redeploy).toBe(true);
  });

  it("deploys anything above the floor when nothing is deployed", () => {
    const d = at({ idleUsd: 200, deployedUsd: 0 });
    expect(d.redeploy).toBe(true);
    expect(d.reason).toMatch(/nothing deployed/);
  });

  it("still respects the floor with nothing deployed", () => {
    expect(at({ idleUsd: 10, deployedUsd: 0 }).redeploy).toBe(false);
  });

  it("reports the share so the log explains the decision", () => {
    expect(at({ idleUsd: 1_000 }).idlePct).toBeCloseTo(10);
    expect(at({ idleUsd: 1_000 }).reason).toMatch(/10\.0%/);
  });

  /** The situation observed live: 0.14 WETH idle against a deployed position. */
  it("catches the real case: ~$345 idle against ~$500 deployed", () => {
    expect(at({ idleUsd: 345, deployedUsd: 500 }).redeploy).toBe(true);
  });

  it("is monotonic in idle capital", () => {
    let seenTrue = false;
    for (const idleUsd of [0, 10, 49, 51, 200, 499, 500, 5_000]) {
      const r = at({ idleUsd }).redeploy;
      if (r) seenTrue = true;
      else expect(seenTrue).toBe(false); // never flips back to false
    }
  });
});
