import { readFileSync } from "node:fs";
import type { AppConfig } from "../config.js";
import { summarizeRawLog } from "../soak/soakReport.js";
import { RULE, pct, usd } from "../backtest/format.js";

/**
 * `npm run soak-report` — summarizes a paper-mode log into a per-day table
 * so the daily soak check is a single command.
 *
 * Usage: npm run soak-report -- --log paper.log [--days 14]
 */
export function runSoakReport(cfg: AppConfig): void {
  const logFile = cfg.soakLogFile;
  let raw: string;
  try {
    raw = readFileSync(logFile, "utf8");
  } catch {
    throw new Error(
      `Cannot read log file ${logFile}. Start the soak with:\n` +
        `  npm run paper 2>&1 | tee -a ${logFile}`,
    );
  }

  const summary = summarizeRawLog(raw);
  const t = summary.totals;

  console.log(RULE);
  console.log("PAPER SOAK REPORT");
  console.log(RULE);
  console.log();
  console.log(`Log file:          ${logFile}`);
  console.log(`Days covered:      ${t.days}`);
  console.log(`Unparsed lines:    ${summary.unparsedLines} (restart banners etc.)`);
  console.log();
  console.log("Day         Buys  Sells  Liq   Err  Drift  Portfolio(EOD)   Price(EOD)");
  console.log("-".repeat(78));
  const shown = cfg.soakDays > 0 ? summary.days.slice(-cfg.soakDays) : summary.days;
  for (const d of shown) {
    console.log(
      [
        d.day,
        String(d.buys).padStart(4),
        String(d.sells).padStart(6),
        String(d.liquidations).padStart(5),
        String(d.errors).padStart(5),
        String(d.driftWarnings).padStart(6),
        d.portfolioValueClose !== null ? usd(d.portfolioValueClose).padStart(15) : "-".padStart(15),
        d.priceClose !== null ? `$${d.priceClose.toFixed(2)}`.padStart(12) : "-".padStart(12),
      ].join("  "),
    );
  }
  console.log();
  console.log(RULE);
  console.log("TOTALS");
  console.log(RULE);
  console.log();
  console.log(`Fills:             ${t.buys} buys / ${t.sells} sells / ${t.liquidations} liquidations`);
  console.log(`Errors:            ${t.errors}`);
  console.log(`Drift warnings:    ${t.driftWarnings}`);
  if (t.portfolioStart !== null && t.portfolioEnd !== null && t.portfolioStart > 0) {
    const ret = ((t.portfolioEnd - t.portfolioStart) / t.portfolioStart) * 100;
    console.log(`Portfolio:         ${usd(t.portfolioStart)} → ${usd(t.portfolioEnd)}  (${pct(ret)})`);
  }
  console.log();

  // Go/no-go hints for the pilot decision.
  const verdicts: string[] = [];
  verdicts.push(t.errors === 0 ? "errors: clean" : `errors: ${t.errors} — investigate before going live`);
  verdicts.push(
    t.driftWarnings === 0
      ? "drift: clean"
      : `drift warnings: ${t.driftWarnings} — simulated inventory diverging from intent`,
  );
  console.log("Pilot checklist:");
  for (const v of verdicts) console.log(`  - ${v}`);
}
