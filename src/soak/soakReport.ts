/**
 * Soak-report aggregation: parses structured JSON log lines from a paper
 * run into per-day summaries. Pure — the tests feed it synthetic lines.
 */

export interface ParsedLine {
  ts: string;
  level: string;
  msg: string;
  [key: string]: unknown;
}

export interface DaySummary {
  day: string;
  buys: number;
  sells: number;
  liquidations: number;
  errors: number;
  driftWarnings: number;
  /** Portfolio value at the last event of the day (USD). */
  portfolioValueClose: number | null;
  portfolioValueOpen: number | null;
  priceClose: number | null;
  cycles: number | null;
}

export interface SoakSummary {
  days: DaySummary[];
  totals: {
    days: number;
    buys: number;
    sells: number;
    liquidations: number;
    errors: number;
    driftWarnings: number;
    /** First-to-last known portfolio value change across the whole soak. */
    portfolioStart: number | null;
    portfolioEnd: number | null;
    netPnlUsd: number | null;
  };
  /** Lines that could not be parsed as JSON (restart banners, etc.). */
  unparsedLines: number;
}

export function parseLogLines(raw: string): { lines: ParsedLine[]; unparsed: number } {
  const lines: ParsedLine[] = [];
  let unparsed = 0;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      if (typeof obj.ts === "string" && typeof obj.msg === "string") {
        lines.push(obj as unknown as ParsedLine);
      } else {
        unparsed++;
      }
    } catch {
      unparsed++;
    }
  }
  return { lines, unparsed };
}

function dayOf(tsIso: string): string {
  return tsIso.slice(0, 10);
}

/** Aggregate parsed log lines into per-day soak summaries. */
export function summarizeSoak(lines: ParsedLine[]): SoakSummary {
  const byDay = new Map<string, DaySummary>();
  const day = (d: string): DaySummary => {
    let entry = byDay.get(d);
    if (!entry) {
      entry = {
        day: d,
        buys: 0,
        sells: 0,
        liquidations: 0,
        errors: 0,
        driftWarnings: 0,
        portfolioValueClose: null,
        portfolioValueOpen: null,
        priceClose: null,
        cycles: null,
      };
      byDay.set(d, entry);
    }
    return entry;
  };

  let firstPortfolio: number | null = null;
  let lastPortfolio: number | null = null;

  // Events in chronological order (log file may span restarts).
  const sorted = [...lines].sort((a, b) => a.ts.localeCompare(b.ts));
  for (const l of sorted) {
    const d = dayOf(l.ts);
    const summary = day(d);

    if (l.level === "error") summary.errors++;
    if (l.level === "warn" || /drift/i.test(String(l.msg))) summary.driftWarnings++;

    switch (l.msg) {
      case "Paper fill": {
        if (l.side === "BUY") summary.buys++;
        else if (l.side === "SELL" && l.gridLevel !== null) summary.sells++;
        else summary.liquidations++;
        break;
      }
      case "Paper cycle":
      case "Paper fill":
      case "Paper day close": {
        const pv = l.portfolioValue;
        if (typeof pv === "number") {
          if (summary.portfolioValueOpen === null) summary.portfolioValueOpen = pv;
          summary.portfolioValueClose = pv;
          if (firstPortfolio === null) firstPortfolio = pv;
          lastPortfolio = pv;
        }
        const px = l.price;
        if (typeof px === "number") summary.priceClose = px;
        if (typeof l.cycles === "number") summary.cycles = l.cycles;
        break;
      }
      default:
        break;
    }
  }

  const days = [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
  return {
    days,
    totals: {
      days: days.length,
      buys: days.reduce((s, d) => s + d.buys, 0),
      sells: days.reduce((s, d) => s + d.sells, 0),
      liquidations: days.reduce((s, d) => s + d.liquidations, 0),
      errors: days.reduce((s, d) => s + d.errors, 0),
      driftWarnings: days.reduce((s, d) => s + d.driftWarnings, 0),
      portfolioStart: firstPortfolio,
      portfolioEnd: lastPortfolio,
      netPnlUsd:
        firstPortfolio !== null && lastPortfolio !== null ? lastPortfolio - firstPortfolio : null,
    },
    unparsedLines: 0, // filled by callers that parse raw text
  };
}

/**
 * Parse raw log text (JSON lines mixed with anything else) and summarize.
 * `unparsedLines` counts lines that were not structured events.
 */
export function summarizeRawLog(raw: string): SoakSummary {
  const { lines, unparsed } = parseLogLines(raw);
  const summary = summarizeSoak(lines);
  summary.unparsedLines = unparsed;
  return summary;
}
