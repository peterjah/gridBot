/** Shared plain-text formatting helpers for the console reports. */

export function usd(n: number): string {
  const abs = Math.abs(n).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${n < 0 ? "-" : ""}$${abs}`;
}

/** Signed USD, always carrying an explicit +/- (for P&L columns). */
export function signedUsd(n: number): string {
  const abs = Math.abs(n).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${n < 0 ? "-" : "+"}$${abs}`;
}

export function pct(n: number, digits = 2): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(digits)}%`;
}

export function price(n: number): string {
  return `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

export function eth(n: number): string {
  return `${n.toFixed(4)} ETH`;
}

export function date(ts: number): string {
  return new Date(ts * 1000).toISOString().replace("T", " ").slice(0, 16);
}

export function day(ts: number): string {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

export const RULE = "=".repeat(80);
export const THIN = "-".repeat(80);

/** Median of a numeric list (0 for empty). */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

export function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

/** Render a fixed-width table from a header row and body rows. */
export function table(headers: string[], rows: string[][], widths: number[]): string[] {
  const pad = (cells: string[]) =>
    cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]!) : c.padEnd(widths[i]!))).join("").trimEnd();
  return [pad(headers), THIN, ...rows.map(pad)];
}
