import { describe, expect, it } from "vitest";
import { nextPollSeconds } from "../src/bot/polling.js";
import type { PollInputs } from "../src/bot/polling.js";

const base: PollInputs = {
  minSeconds: 30,
  maxSeconds: 600,
  distanceTicks: null,
  thresholdTicks: 723,
  cooldownRemainingSeconds: 0,
  trailingMovePct: null,
  regimeMaxMovePct: 0,
  regimeReenterMaxPct: 0,
  parked: false,
  hedgeOpen: false,
  hedgeMaxSeconds: 60,
};

const at = (o: Partial<PollInputs>) => nextPollSeconds({ ...base, ...o });

describe("bounds", () => {
  it("never returns less than the floor or more than the ceiling", () => {
    for (const distanceTicks of [0, 100, 700, 723, 5000, -900]) {
      for (const cooldownRemainingSeconds of [0, 10, 100_000]) {
        const d = at({ distanceTicks, cooldownRemainingSeconds });
        expect(d.seconds).toBeGreaterThanOrEqual(base.minSeconds);
        expect(d.seconds).toBeLessThanOrEqual(base.maxSeconds);
      }
    }
  });

  it("returns whole seconds", () => {
    expect(Number.isInteger(at({ distanceTicks: 337 }).seconds)).toBe(true);
  });

  it("survives a floor above the ceiling without inverting", () => {
    const d = nextPollSeconds({ ...base, minSeconds: 600, maxSeconds: 30 });
    expect(d.seconds).toBe(600);
  });
});

describe("re-centre distance", () => {
  it("polls slowly when the position sits at its centre", () => {
    expect(at({ distanceTicks: 0 }).seconds).toBe(base.maxSeconds);
  });

  it("polls at the floor once the trigger is reached", () => {
    expect(at({ distanceTicks: 723 }).seconds).toBe(base.minSeconds);
  });

  it("tightens monotonically as price approaches the trigger", () => {
    const seconds = [0, 100, 300, 500, 700, 723].map(
      (distanceTicks) => at({ distanceTicks }).seconds,
    );
    for (let i = 1; i < seconds.length; i++) {
      expect(seconds[i]!).toBeLessThanOrEqual(seconds[i - 1]!);
    }
  });

  it("treats distance as absolute, so both directions tighten", () => {
    expect(at({ distanceTicks: -700 }).seconds).toBe(at({ distanceTicks: 700 }).seconds);
  });

  it("does not overshoot past the trigger", () => {
    expect(at({ distanceTicks: 10_000 }).seconds).toBe(base.minSeconds);
  });
});

describe("regime boundary", () => {
  it("tightens as a deployed position approaches the exit threshold", () => {
    const far = at({ regimeMaxMovePct: 3, trailingMovePct: 0.3 }).seconds;
    const near = at({ regimeMaxMovePct: 3, trailingMovePct: 2.9 }).seconds;
    expect(near).toBeLessThan(far);
  });

  it("tightens as a parked bot's move decays toward re-entry", () => {
    // Parked: urgency rises as the move FALLS toward the re-entry threshold.
    const far = at({
      parked: true,
      regimeMaxMovePct: 3,
      regimeReenterMaxPct: 2.25,
      trailingMovePct: 30,
    }).seconds;
    const near = at({
      parked: true,
      regimeMaxMovePct: 3,
      regimeReenterMaxPct: 2.25,
      trailingMovePct: 2.4,
    }).seconds;
    expect(near).toBeLessThan(far);
  });

  /** The situation that drained the quota: parked, nothing can happen for days. */
  it("polls near the ceiling when parked far from re-entry", () => {
    // A 30% move must decay to 2.25% before anything happens, so urgency is
    // low but not zero — the interval sits near the ceiling, not exactly on it.
    const d = at({
      parked: true,
      regimeMaxMovePct: 3,
      regimeReenterMaxPct: 2.25,
      trailingMovePct: 30,
    });
    expect(d.seconds).toBeGreaterThan(base.maxSeconds * 0.9);
    expect(d.urgency).toBeLessThan(0.1);
  });

  it("ignores the regime when the filter is off", () => {
    expect(at({ regimeMaxMovePct: 0, trailingMovePct: 50 }).seconds).toBe(base.maxSeconds);
  });

  it("ignores an unfilled window rather than guessing", () => {
    expect(at({ regimeMaxMovePct: 3, trailingMovePct: null }).seconds).toBe(base.maxSeconds);
  });
});

describe("cooldown", () => {
  /**
   * A cooldown shorter than the interval urgency already chose changes
   * nothing: sleeping less than we safely could would just spend a call to
   * re-read a quiet state.
   */
  it("does not shorten an interval that already outlasts the cooldown", () => {
    expect(at({ cooldownRemainingSeconds: 400 }).seconds).toBe(base.maxSeconds);
  });

  it("extends a short interval to the cooldown expiry", () => {
    // Urgent enough to want the floor, but nothing can fire for 400s.
    const d = at({ distanceTicks: 723, cooldownRemainingSeconds: 400 });
    expect(d.seconds).toBe(400);
    expect(d.reason).toMatch(/cooldown/);
  });

  it("still respects the ceiling", () => {
    expect(at({ cooldownRemainingSeconds: 86_400 }).seconds).toBe(base.maxSeconds);
  });

  /**
   * A cooldown blocks re-centring, so it must not be shortened by price
   * approaching a trigger that cannot fire.
   */
  it("outranks urgency while it is longer", () => {
    const d = at({ distanceTicks: 720, cooldownRemainingSeconds: 500 });
    expect(d.seconds).toBe(500);
    expect(d.reason).toMatch(/cooldown/);
  });

  it("yields to urgency once it is shorter than the urgent interval", () => {
    const d = at({ distanceTicks: 0, cooldownRemainingSeconds: 10 });
    expect(d.seconds).toBe(base.maxSeconds);
  });
});

describe("hedge", () => {
  it("caps the interval while a short is open", () => {
    const d = at({ hedgeOpen: true, hedgeMaxSeconds: 60 });
    expect(d.seconds).toBe(60);
    expect(d.reason).toMatch(/health factor/);
  });

  it("caps even a long cooldown, because liquidation does not wait", () => {
    const d = at({ hedgeOpen: true, hedgeMaxSeconds: 60, cooldownRemainingSeconds: 86_400 });
    expect(d.seconds).toBe(60);
  });

  it("does not lengthen an already-shorter interval", () => {
    const d = at({ hedgeOpen: true, hedgeMaxSeconds: 600, distanceTicks: 723 });
    expect(d.seconds).toBe(base.minSeconds);
  });
});

describe("reporting", () => {
  it("names the driver so the log explains itself", () => {
    expect(at({ distanceTicks: 700 }).reason).toMatch(/re-centre distance/);
    expect(at({ regimeMaxMovePct: 3, trailingMovePct: 2.9 }).reason).toMatch(/regime exit/);
    expect(
      at({ parked: true, regimeMaxMovePct: 3, regimeReenterMaxPct: 2.25, trailingMovePct: 2.4 })
        .reason,
    ).toMatch(/regime re-entry/);
  });

  it("reports urgency in [0,1]", () => {
    for (const distanceTicks of [0, 300, 723, 9999]) {
      const u = at({ distanceTicks }).urgency;
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThanOrEqual(1);
    }
  });
});
