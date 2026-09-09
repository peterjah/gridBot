import { describe, expect, it } from "vitest";
import { emptyState, measuredFeeApr, recordExposure } from "../src/bot/state.js";

const DAY = 86_400;
// lastExposureAt = 0 means "never sampled", so tests use real unix times.
const T0 = 1_800_000_000;

describe("recordExposure", () => {
  it("credits nothing on the first observation", () => {
    const s = emptyState();
    recordExposure(s, 1_000, 10_000, true);
    expect(s.deployedUsdSeconds).toBe(0);
    expect(s.lastExposureAt).toBe(1_000);
  });

  it("integrates capital over time", () => {
    const s = emptyState();
    recordExposure(s, T0, 10_000, true);
    recordExposure(s, T0 + 3_600, 10_000, true, DAY);
    expect(s.deployedUsdSeconds).toBe(10_000 * 3_600);
    expect(s.deployedSeconds).toBe(3_600);
    expect(s.inRangeSeconds).toBe(3_600);
  });

  it("counts out-of-range time as deployed but not earning", () => {
    const s = emptyState();
    recordExposure(s, T0, 10_000, true);
    recordExposure(s, T0 + 3_600, 10_000, false, DAY);
    expect(s.deployedSeconds).toBe(3_600);
    expect(s.inRangeSeconds).toBe(0);
  });

  it("credits nothing while nothing is deployed", () => {
    const s = emptyState();
    recordExposure(s, T0, 0, false);
    recordExposure(s, T0 + 3_600, 0, false, DAY);
    expect(s.deployedUsdSeconds).toBe(0);
    expect(s.deployedSeconds).toBe(0);
  });

  /**
   * A restart or an RPC outage must not credit the gap as deployed time: the
   * denominator would grow without any matching fees and understate the rate.
   */
  it("caps the gap so an outage cannot dilute the rate", () => {
    const s = emptyState();
    recordExposure(s, T0, 10_000, true);
    recordExposure(s, T0 + 30 * DAY, 10_000, true, 3_600);
    expect(s.deployedSeconds).toBe(3_600);
  });

  it("ignores time going backwards", () => {
    const s = emptyState();
    recordExposure(s, T0 + 10_000, 10_000, true);
    recordExposure(s, T0 + 5_000, 10_000, true);
    expect(s.deployedSeconds).toBe(0);
  });

  it("weights by capital, not just by time", () => {
    const small = emptyState();
    recordExposure(small, T0, 50, true);
    recordExposure(small, T0 + DAY, 50, true, DAY);
    const large = emptyState();
    recordExposure(large, T0, 400, true);
    recordExposure(large, T0 + DAY, 400, true, DAY);
    expect(large.deployedUsdSeconds / small.deployedUsdSeconds).toBeCloseTo(8);
  });
});

describe("measuredFeeApr", () => {
  it("is null before any exposure", () => {
    expect(measuredFeeApr(emptyState())).toBeNull();
  });

  it("recovers a known rate exactly", () => {
    // $10,000 deployed for a full year earning $2,000 == 20% APR.
    const s = emptyState();
    s.feesUsd = 2_000;
    s.deployedUsdSeconds = 10_000 * 365 * DAY;
    s.deployedSeconds = 365 * DAY;
    s.inRangeSeconds = 365 * DAY;
    const r = measuredFeeApr(s)!;
    expect(r.overall).toBeCloseTo(20, 6);
    expect(r.inRangePct).toBeCloseTo(100, 6);
    expect(r.inRange).toBeCloseTo(20, 6);
  });

  /**
   * The in-range restatement is what compares to a pool's published APR: half
   * the time out of range means the earning half was working twice as hard.
   */
  it("restates the rate over earning time only", () => {
    const s = emptyState();
    s.feesUsd = 1_000;
    s.deployedUsdSeconds = 10_000 * 365 * DAY;
    s.deployedSeconds = 365 * DAY;
    s.inRangeSeconds = (365 * DAY) / 2;
    const r = measuredFeeApr(s)!;
    expect(r.overall).toBeCloseTo(10, 6);
    expect(r.inRangePct).toBeCloseTo(50, 6);
    expect(r.inRange).toBeCloseTo(20, 6);
  });

  /** The situation this exists to expose: capital badly under-deployed. */
  it("does not credit capital that was never deployed", () => {
    const s = emptyState();
    s.feesUsd = 0.42;
    // $50 working, not the $400 in the account.
    s.deployedUsdSeconds = 50 * 6.7 * DAY;
    s.deployedSeconds = 6.7 * DAY;
    s.inRangeSeconds = 6.7 * DAY;
    const r = measuredFeeApr(s)!;
    // ~46% on the capital actually at work, not ~6% on the nominal account.
    expect(r.overall).toBeGreaterThan(40);
    expect(r.overall).toBeLessThan(50);
  });
});
