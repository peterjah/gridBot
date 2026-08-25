import { describe, expect, it } from "vitest";
import { summarizeRawLog } from "../src/soak/soakReport.js";

function line(ts: string, msg: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ ts, level: "info", msg, ...extra });
}

describe("soak report aggregation", () => {
  const raw = [
    line("2026-08-01T00:00:10Z", "Paper trading started", {}),
    line("2026-08-01T00:01:00Z", "Paper cycle", {
      price: 2400,
      portfolioValue: 1000,
      cycles: 0,
      usdc: 1000,
      eth: 0,
    }),
    line("2026-08-01T12:30:00Z", "Paper fill", {
      side: "BUY",
      gridLevel: -1,
      price: 2380,
      amount: 50,
      portfolioValue: 1002,
    }),
    line("2026-08-01T18:00:00Z", "Paper fill", {
      side: "SELL",
      gridLevel: 0,
      price: 2410,
      amount: 0.02,
      portfolioValue: 1003,
    }),
    line("2026-08-01T23:59:59Z", "Paper day close", {
      day: "2026-08-01",
      price: 2415,
      portfolioValue: 1004,
    }),
    line("2026-08-02T00:05:00Z", "Paper cycle", {
      price: 2420,
      portfolioValue: 1005,
      cycles: 1,
    }),
    line("2026-08-02T02:00:00Z", "Cycle failed", { error: "boom" }),
    line("2026-08-02T03:00:00Z", "Inventory drift detected — simulated vs chain", {}),
    "npm install deprecation warning, not json",
    line("2026-08-02T04:00:00Z", "Paper fill", {
      side: "LIQUIDATE",
      gridLevel: null,
      price: 2300,
      amount: 0.5,
      portfolioValue: 990,
    }),
  ].join("\n");

  it("aggregates per-day summaries", () => {
    const s = summarizeRawLog(raw);
    expect(s.unparsedLines).toBe(1);
    expect(s.days).toHaveLength(2);

    const d1 = s.days[0]!;
    expect(d1.day).toBe("2026-08-01");
    expect(d1.buys).toBe(1);
    expect(d1.sells).toBe(1);
    expect(d1.errors).toBe(0);
    expect(d1.portfolioValueOpen).toBeCloseTo(1000);
    expect(d1.portfolioValueClose).toBeCloseTo(1004);

    const d2 = s.days[1]!;
    expect(d2.errors).toBe(1); // level=error
    expect(d2.driftWarnings).toBeGreaterThanOrEqual(1);
    expect(d2.liquidations).toBe(1);
    expect(d2.portfolioValueClose).toBeCloseTo(990);
  });

  it("computes correct totals including net pnl across restarts", () => {
    const s = summarizeRawLog(raw);
    expect(s.totals.buys).toBe(1);
    expect(s.totals.sells).toBe(1);
    expect(s.totals.liquidations).toBe(1);
    expect(s.totals.errors).toBe(1);
    expect(s.totals.portfolioStart).toBeCloseTo(1000);
    expect(s.totals.portfolioEnd).toBeCloseTo(990);
    expect(s.totals.netPnlUsd).toBeCloseTo(-10);
  });

  it("survives an empty log", () => {
    const s = summarizeRawLog("");
    expect(s.days).toHaveLength(0);
    expect(s.totals.netPnlUsd).toBeNull();
  });
});
