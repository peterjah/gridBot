import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  captureProvenance,
  fingerprintCode,
  fingerprintDataset,
} from "../src/backtest/provenance.js";
import { loadRuns, saveRun } from "../src/backtest/runStore.js";
import type { RunSummary } from "../src/backtest/runStore.js";

const dir = mkdtempSync(join(tmpdir(), "gridbot-prov-"));

function writeCsv(name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, body);
  return path;
}

describe("dataset fingerprint", () => {
  it("captures rows, range and a content hash", () => {
    const path = writeCsv(
      "p.csv",
      "timestamp,price\n1700000000,4000\n1700003600,4010\n1700007200,4020\n",
    );
    const fp = fingerprintDataset(path, "prices");
    expect(fp.rows).toBe(3);
    expect(fp.firstTimestamp).toBe(1_700_000_000);
    expect(fp.lastTimestamp).toBe(1_700_007_200);
    expect(fp.sha256).toMatch(/^[0-9a-f]{16}$/);
  });

  it("changes when the file content changes", () => {
    const a = fingerprintDataset(writeCsv("a.csv", "timestamp,price\n1,4000\n"), "prices");
    const b = fingerprintDataset(writeCsv("b.csv", "timestamp,price\n1,4001\n"), "prices");
    // A silently regenerated dataset must not look identical to the old one.
    expect(a.sha256).not.toBe(b.sha256);
  });

  it("handles ISO date rows (the APR series format)", () => {
    const fp = fingerprintDataset(
      writeCsv("apr.csv", "date,apr_pct,tvl_usd\n2025-01-01,50,1000000\n2025-01-02,60,1000000\n"),
      "apr",
    );
    expect(fp.rows).toBe(2);
    expect(fp.firstTimestamp).toBe(Math.floor(Date.parse("2025-01-01") / 1000));
  });
});

describe("code fingerprint", () => {
  it("produces a stable hash of the source tree", () => {
    const a = fingerprintCode();
    const b = fingerprintCode();
    expect(a.srcSha256).toBe(b.srcSha256);
    expect(a.srcSha256).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("captureProvenance", () => {
  it("records the income model, which is the largest result driver", () => {
    const path = writeCsv("q.csv", "timestamp,price\n1700000000,4000\n");
    const p = captureProvenance({
      pricesFile: path,
      aprFile: null,
      lpFeeIncomeActive: true,
      lpCalibration: "measured-apr-series",
      lendingYield: false,
    });
    expect(p.income.lpFeeIncome).toBe(true);
    expect(p.income.lpCalibration).toBe("measured-apr-series");
    expect(p.income.lendingYield).toBe(false);
    expect(p.datasets).toHaveLength(1);
    expect(p.code.srcSha256).toBeTruthy();
  });

  it("fingerprints the APR series as a second dataset", () => {
    const prices = writeCsv("r.csv", "timestamp,price\n1700000000,4000\n");
    const apr = writeCsv("s.csv", "date,apr_pct\n2025-01-01,50\n");
    const p = captureProvenance({
      pricesFile: prices,
      aprFile: apr,
      lpFeeIncomeActive: true,
      lpCalibration: "measured-apr-series",
      lendingYield: false,
    });
    expect(p.datasets.map((d) => d.role)).toEqual(["prices", "apr"]);
  });
});

describe("run store supersession", () => {
  const summary = (label: string, ret: number): RunSummary =>
    ({
      label,
      mode: "backtest",
      createdAt: new Date(Date.now() + ret * 1000).toISOString(),
      dataFile: "x.csv",
      periodStart: 0,
      periodEnd: 1,
      initialCapital: 10_000,
      spec: "spacing=1",
      description: "t",
      metrics: { returnPercent: ret } as RunSummary["metrics"],
    }) as RunSummary;

  it("archives a superseded run instead of erasing it", () => {
    const store = mkdtempSync(join(tmpdir(), "gridbot-store-"));
    saveRun(store, summary("dup", 100));
    saveRun(store, summary("dup", 42));

    const runs = loadRuns(store);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.metrics.returnPercent).toBe(42);

    // The overwritten number must still be recoverable for an audit.
    const files = readdirSync(join(store, "dup"));
    const archived = files.filter((f) => f.startsWith("superseded-"));
    expect(archived).toHaveLength(1);
    const prev = JSON.parse(readFileSync(join(store, "dup", archived[0]!), "utf8"));
    expect(prev.metrics.returnPercent).toBe(100);
  });
});
