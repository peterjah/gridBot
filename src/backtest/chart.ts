import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { BacktestResult } from "./backtester.js";
import type { Benchmark } from "./benchmarks.js";

/**
 * Self-contained HTML report with inline SVG charts:
 *   1. ETH price + grid center + reset points + trade markers
 *   2. Portfolio value vs USDC-only vs ETH buy & hold (ONE shared scale)
 *   3. ETH inventory over time
 *
 * Colour roles are fixed across every chart so an entity keeps its identity:
 *   blue   = the grid strategy      orange = ETH        aqua = grid machinery
 * Each chart uses at most three categorical hues, which is the documented
 * all-pairs-safe cap for this palette.
 */
export function writeChartReport(
  result: BacktestResult,
  benchmarks: Benchmark[],
  outPath: string,
): string {
  const html = renderHtml(result, benchmarks);
  mkdirSync(dirname(outPath) || ".", { recursive: true });
  writeFileSync(outPath, html);
  return outPath;
}

const W = 960;
const H = 320;
const PAD = { top: 16, right: 16, bottom: 28, left: 64 };

interface Point {
  x: number;
  y: number;
}

interface Series {
  name: string;
  points: Point[];
  color: string;
  width?: number;
  dash?: string;
}

interface Scale {
  x: (v: number) => number;
  y: (v: number) => number;
  domainY: [number, number];
  domainX: [number, number];
}

/**
 * ONE scale per chart, computed over every series it contains. Scaling each
 * series independently (as an earlier version did) makes curves that share an
 * axis visually incomparable — the classic dual-scale mistake.
 */
function sharedScale(series: Series[], includeZero = false): Scale {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const s of series) {
    for (const p of s.points) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
  }
  if (!Number.isFinite(minX)) {
    minX = 0;
    maxX = 1;
    minY = 0;
    maxY = 1;
  }
  if (includeZero) minY = Math.min(minY, 0);
  const padY = (maxY - minY) * 0.06 || Math.abs(maxY) * 0.06 || 1;
  minY -= padY;
  maxY += padY;

  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  return {
    x: (v) => PAD.left + ((v - minX) / (maxX - minX || 1)) * plotW,
    y: (v) => PAD.top + plotH - ((v - minY) / (maxY - minY || 1)) * plotH,
    domainY: [minY, maxY],
    domainX: [minX, maxX],
  };
}

/** Downsample to at most `max` points, always keeping the last one. */
function downsample(points: Point[], max = 1500): Point[] {
  if (points.length <= max) return points;
  const step = Math.ceil(points.length / max);
  const out: Point[] = [];
  for (let i = 0; i < points.length; i += step) out.push(points[i]!);
  const last = points[points.length - 1]!;
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

function pathData(points: Point[], scale: Scale): string {
  if (points.length === 0) return "";
  return points
    .map((p, i) => `${i === 0 ? "M" : "L"}${scale.x(p.x).toFixed(1)},${scale.y(p.y).toFixed(1)}`)
    .join(" ");
}

function niceTicks(min: number, max: number, count = 5): number[] {
  const span = max - min;
  if (!(span > 0)) return [min];
  const rawStep = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const norm = rawStep / mag;
  const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
  const ticks: number[] = [];
  for (let t = Math.ceil(min / step) * step; t <= max; t += step) ticks.push(t);
  return ticks;
}

function fmtUsd(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1000) return `$${(n / 1000).toFixed(abs >= 10_000 ? 0 : 1)}k`;
  return `$${n.toFixed(abs < 10 ? 2 : 0)}`;
}

function fmtDay(ts: number): string {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

/** Axes, recessive grid lines and tick labels. */
function axes(scale: Scale, yFormat: (n: number) => string): string {
  const yTicks = niceTicks(scale.domainY[0], scale.domainY[1]);
  const xTicks = niceTicks(scale.domainX[0], scale.domainX[1], 5);
  const parts: string[] = [];
  for (const t of yTicks) {
    const y = scale.y(t).toFixed(1);
    parts.push(
      `<line class="grid" x1="${PAD.left}" x2="${W - PAD.right}" y1="${y}" y2="${y}"/>`,
      `<text class="tick" x="${PAD.left - 8}" y="${y}" text-anchor="end" dominant-baseline="middle">${yFormat(t)}</text>`,
    );
  }
  for (const t of xTicks) {
    const x = scale.x(t).toFixed(1);
    parts.push(
      `<text class="tick" x="${x}" y="${H - 8}" text-anchor="middle">${fmtDay(t)}</text>`,
    );
  }
  return parts.join("\n  ");
}

function legend(entries: { name: string; color: string; dash?: string }[]): string {
  return `<div class="legend">${entries
    .map(
      (e) =>
        `<span class="key"><svg width="18" height="10" aria-hidden="true"><line x1="1" y1="5" x2="17" y2="5" stroke="${e.color}" stroke-width="2"${e.dash ? ` stroke-dasharray="${e.dash}"` : ""}/></svg>${escapeHtml(e.name)}</span>`,
    )
    .join("")}</div>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

/** A full chart: shared scale, axes, series, optional extra marks. */
function chart(
  id: string,
  series: Series[],
  yFormat: (n: number) => string,
  extras: (scale: Scale) => string = () => "",
  includeZero = false,
): { svg: string; scale: Scale } {
  const drawn = series.map((s) => ({ ...s, points: downsample(s.points) }));
  const scale = sharedScale(drawn, includeZero);
  const paths = drawn
    .map(
      (s) =>
        `<path d="${pathData(s.points, scale)}" fill="none" stroke="${s.color}" stroke-width="${s.width ?? 2}"${s.dash ? ` stroke-dasharray="${s.dash}"` : ""} stroke-linejoin="round"/>`,
    )
    .join("\n  ");

  const svg = `<svg id="${id}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img">
  ${axes(scale, yFormat)}
  ${extras(scale)}
  ${paths}
  <g class="crosshair" hidden><line y1="${PAD.top}" y2="${H - PAD.bottom}"/></g>
</svg>`;
  return { svg, scale };
}

function renderHtml(result: BacktestResult, benchmarks: Benchmark[]): string {
  const { samples } = result;
  const state = result.strategy.getState();
  const t0 = samples[0]!.timestamp;
  const t1 = samples[samples.length - 1]!.timestamp;

  const priceSeries: Series = {
    name: "ETH price",
    points: samples.map((s) => ({ x: s.timestamp, y: s.price })),
    color: "var(--eth)",
  };

  // Grid center as a step function: it only changes at a rebuild.
  const centerPoints: Point[] = [{ x: t0, y: result.strategy.config.centerPrice }];
  for (const change of state.centerHistory) {
    centerPoints.push({ x: change.timestamp, y: change.oldCenter });
    centerPoints.push({ x: change.timestamp, y: change.newCenter });
  }
  centerPoints.push({ x: t1, y: state.centerPrice });
  const centerSeries: Series = {
    name: "Grid center",
    points: centerPoints,
    color: "var(--grid)",
    width: 1.5,
  };

  // Reset points: recessive vertical rules plus a tick on the axis, so the
  // eye can line every re-centering up against the price path.
  const resetMarks = (scale: Scale) =>
    result.resets
      .map((r) => {
        const x = scale.x(r.timestamp).toFixed(1);
        return `<line class="reset" x1="${x}" x2="${x}" y1="${PAD.top}" y2="${H - PAD.bottom}"><title>Reset #${r.id} — ${fmtDay(r.timestamp)}</title></line>` +
          `<polygon class="reset-tick" points="${x},${H - PAD.bottom} ${Number(x) - 4},${H - PAD.bottom + 7} ${Number(x) + 4},${H - PAD.bottom + 7}"/>`;
      })
      .join("\n  ");

  // Trade markers: side is encoded by SHAPE (up = buy, down = sell), not by a
  // second hue — one less colour to tell apart, and it survives CVD/print.
  const tradeMarks = (scale: Scale) =>
    state.trades
      .map((t) => {
        const x = scale.x(t.timestamp);
        const y = scale.y(t.fillPrice);
        const d = t.side === "BUY" ? -1 : 1;
        const cls = t.liquidation ? "mark liq" : "mark";
        return `<polygon class="${cls}" points="${x.toFixed(1)},${(y + d * 4).toFixed(1)} ${(x - 3.5).toFixed(1)},${(y - d * 2).toFixed(1)} ${(x + 3.5).toFixed(1)},${(y - d * 2).toFixed(1)}"><title>${t.liquidation ? "LIQUIDATE" : t.side} ${t.ethAmount.toFixed(4)} ETH @ $${t.fillPrice.toFixed(2)}</title></polygon>`;
      })
      .join("\n  ");

  const priceChart = chart(
    "chart-price",
    [priceSeries, centerSeries],
    fmtUsd,
    (scale) => `${resetMarks(scale)}\n  ${tradeMarks(scale)}`,
  );

  const ethHold = benchmarks.find((b) => b.name.startsWith("ETH"));
  const equityChart = chart(
    "chart-equity",
    [
      {
        name: "Grid strategy",
        points: samples.map((s) => ({ x: s.timestamp, y: s.portfolioValue })),
        color: "var(--strategy)",
      },
      {
        name: "ETH buy & hold",
        points: samples.map((s) => ({
          x: s.timestamp,
          y: (result.initialCapital / samples[0]!.price) * s.price,
        })),
        color: "var(--eth)",
        width: 1.5,
      },
      {
        name: "USDC only",
        points: [
          { x: t0, y: result.initialCapital },
          { x: t1, y: result.initialCapital },
        ],
        color: "var(--muted-line)",
        width: 1.5,
        dash: "5,4",
      },
    ],
    fmtUsd,
  );

  const inventoryChart = chart(
    "chart-inventory",
    [
      {
        name: "ETH inventory",
        points: samples.map((s) => ({ x: s.timestamp, y: s.eth })),
        color: "var(--eth)",
      },
    ],
    (n) => n.toFixed(2),
    () => "",
    true,
  );

  const benchRows = [
    { name: "Grid strategy", value: result.finalPortfolioValue, strong: true },
    ...benchmarks.map((b) => ({ name: b.name, value: b.finalValue, strong: false })),
  ]
    .map((row) => {
      const ret = ((row.value - result.initialCapital) / result.initialCapital) * 100;
      const cell = (s: string) => (row.strong ? `<b>${s}</b>` : s);
      return `<tr><td>${cell(escapeHtml(row.name))}</td><td class="num">${cell(`$${row.value.toFixed(2)}`)}</td><td class="num">${cell(`${ret >= 0 ? "+" : ""}${ret.toFixed(2)}%`)}</td></tr>`;
    })
    .join("");

  const resetRows = result.resets
    .map(
      (r) =>
        `<tr><td class="num">${r.id}</td><td>${fmtDay(r.timestamp)}</td><td>${r.reason}</td><td class="num">$${r.price.toFixed(2)}</td><td class="num">${r.ethInventoryBefore.toFixed(4)}</td><td class="num">$${r.ethAvgCostPrice.toFixed(2)}</td><td class="num ${r.realizedResetPnlUsd < 0 ? "neg" : "pos"}">${r.realizedResetPnlUsd >= 0 ? "+" : "−"}$${Math.abs(r.realizedResetPnlUsd).toFixed(2)}</td><td class="num ${r.gridNetSincePrevUsd < 0 ? "neg" : "pos"}">${r.gridNetSincePrevUsd >= 0 ? "+" : "−"}$${Math.abs(r.gridNetSincePrevUsd).toFixed(2)}</td><td class="num">$${r.portfolioValueAfter.toFixed(2)}</td></tr>`,
    )
    .join("");

  const pnl = result.breakdown;
  const costs = pnl.feesUsd + pnl.slippageUsd + pnl.gasUsd;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Grid backtest report</title>
<style>
  :root {
    color-scheme: light;
    --surface: #fcfcfb;
    --page: #f4f4f2;
    --border: #e2e2dd;
    --text: #0b0b0b;
    --text-2: #52514e;
    --muted: #8a8981;
    --muted-line: #b6b5ad;
    --strategy: #2a78d6;
    --eth: #eb6834;
    --grid: #1baf7a;
    --neg: #b02a29;
    --pos: #0a6b46;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      color-scheme: dark;
      --surface: #1a1a19;
      --page: #121211;
      --border: #34342f;
      --text: #ffffff;
      --text-2: #c3c2b7;
      --muted: #8a8981;
      --muted-line: #56564f;
      --strategy: #3987e5;
      --eth: #d95926;
      --grid: #199e70;
      --neg: #e66767;
      --pos: #3fbf8f;
    }
  }
  * { box-sizing: border-box; }
  body {
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    margin: 0; padding: 2rem 1.5rem 4rem; background: var(--page); color: var(--text);
    max-width: 1060px; margin-inline: auto; line-height: 1.5;
  }
  h1 { font-size: 1.5rem; margin: 0 0 .25rem; letter-spacing: -.01em; }
  h2 { font-size: 1rem; margin: 2.5rem 0 .5rem; letter-spacing: .02em; text-transform: uppercase; color: var(--text-2); }
  .sub { color: var(--text-2); font-size: .875rem; margin: 0 0 1.5rem; }
  .figure { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: .75rem; overflow-x: auto; position: relative; }
  .figure svg { display: block; width: 100%; height: auto; min-width: 640px; }
  /* Legend swatches must keep their intrinsic size — the rule above is
     deliberately scoped to .figure so it cannot stretch them. */
  .key svg { display: block; width: 18px; height: 10px; flex: none; }
  .grid { stroke: var(--border); stroke-width: 1; }
  .tick { fill: var(--muted); font-size: 11px; font-family: ui-monospace, monospace; }
  .reset { stroke: var(--muted-line); stroke-width: 1; stroke-dasharray: 2,4; }
  .reset-tick { fill: var(--muted-line); }
  .mark { fill: var(--grid); opacity: .85; }
  .mark.liq { fill: var(--muted); }
  .crosshair line { stroke: var(--muted-line); stroke-width: 1; }
  .legend { display: flex; flex-wrap: wrap; gap: 1rem; font-size: .8125rem; color: var(--text-2); margin-top: .5rem; }
  .key { display: inline-flex; align-items: center; gap: .375rem; }
  .note { font-size: .8125rem; color: var(--muted); margin-top: .375rem; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: .75rem; margin: 1.5rem 0; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: .75rem .875rem; }
  .card .label { font-size: .75rem; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
  .card .value { font-size: 1.25rem; font-variant-numeric: tabular-nums; margin-top: .125rem; }
  table { border-collapse: collapse; width: 100%; font-size: .8125rem; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
  th { text-align: left; font-weight: 600; color: var(--text-2); font-size: .75rem; text-transform: uppercase; letter-spacing: .03em; }
  td, th { padding: .5rem .75rem; border-bottom: 1px solid var(--border); }
  tr:last-child td { border-bottom: none; }
  .num { text-align: right; font-variant-numeric: tabular-nums; font-family: ui-monospace, monospace; }
  .neg { color: var(--neg); }
  .pos { color: var(--pos); }
  .scroll { overflow-x: auto; }
  .tooltip { position: absolute; pointer-events: none; background: var(--surface); border: 1px solid var(--border); border-radius: 6px; padding: .375rem .5rem; font-size: .75rem; font-family: ui-monospace, monospace; white-space: pre; box-shadow: 0 2px 8px rgb(0 0 0 / .12); opacity: 0; transition: opacity .08s; }
</style>
</head>
<body>
<h1>Grid backtest report</h1>
<p class="sub">${fmtDay(t0)} → ${fmtDay(t1)} · ${samples.length.toLocaleString("en-US")} observations · ${result.resets.length} resets · ${result.buysExecuted + result.sellsExecuted} trades</p>

<div class="cards">
  <div class="card"><div class="label">Final value</div><div class="value">$${result.finalPortfolioValue.toFixed(2)}</div></div>
  <div class="card"><div class="label">Return</div><div class="value ${result.returnPct < 0 ? "neg" : "pos"}">${result.returnPct >= 0 ? "+" : ""}${result.returnPct.toFixed(2)}%</div></div>
  <div class="card"><div class="label">Max drawdown</div><div class="value">${result.maxDrawdownPct.toFixed(2)}%</div></div>
  <div class="card"><div class="label">Grid P&amp;L</div><div class="value ${pnl.gridPnlUsd < 0 ? "neg" : "pos"}">${pnl.gridPnlUsd >= 0 ? "+" : "−"}$${Math.abs(pnl.gridPnlUsd).toFixed(2)}</div></div>
  <div class="card"><div class="label">Reset P&amp;L</div><div class="value ${pnl.resetPnlUsd < 0 ? "neg" : "pos"}">${pnl.resetPnlUsd >= 0 ? "+" : "−"}$${Math.abs(pnl.resetPnlUsd).toFixed(2)}</div></div>
  <div class="card"><div class="label">Trading costs</div><div class="value neg">−$${costs.toFixed(2)}</div></div>
</div>

<h2>ETH price, grid center &amp; resets</h2>
<div class="figure">${priceChart.svg}</div>
${legend([
  { name: "ETH price", color: "var(--eth)" },
  { name: "Grid center", color: "var(--grid)" },
  { name: "Reset (dashed rule)", color: "var(--muted-line)", dash: "2,3" },
])}
<p class="note">Triangles are fills — pointing up for buys, down for sells. Grey triangles are reset liquidations. Hover any mark for its details.</p>

<h2>Portfolio value vs benchmarks</h2>
<div class="figure">${equityChart.svg}</div>
${legend([
  { name: "Grid strategy", color: "var(--strategy)" },
  { name: "ETH buy & hold", color: "var(--eth)" },
  { name: "USDC only", color: "var(--muted-line)", dash: "5,4" },
])}
<p class="note">All three curves share one y-axis, so their heights are directly comparable.</p>

<h2>ETH inventory</h2>
<div class="figure">${inventoryChart.svg}</div>
<p class="note">ETH held over time. Peak inventory ${result.inventory.maxEth.toFixed(4)} ETH (${result.inventory.maxEthExposurePct.toFixed(1)}% of the portfolio at its largest); each drop to zero is a reset liquidation.</p>

<h2>P&amp;L decomposition</h2>
<table>
<tr><th>Component</th><th class="num">USD</th></tr>
<tr><td>Initial capital</td><td class="num">$${pnl.initialCapital.toFixed(2)}</td></tr>
<tr><td>A · Grid trading P&amp;L</td><td class="num ${pnl.gridPnlUsd < 0 ? "neg" : "pos"}">${pnl.gridPnlUsd >= 0 ? "+" : "−"}$${Math.abs(pnl.gridPnlUsd).toFixed(2)}</td></tr>
<tr><td>B · Reset / inventory P&amp;L</td><td class="num ${pnl.resetPnlUsd < 0 ? "neg" : "pos"}">${pnl.resetPnlUsd >= 0 ? "+" : "−"}$${Math.abs(pnl.resetPnlUsd).toFixed(2)}</td></tr>
<tr><td>Unrealized P&amp;L (open inventory)</td><td class="num ${pnl.unrealizedPnlUsd < 0 ? "neg" : "pos"}">${pnl.unrealizedPnlUsd >= 0 ? "+" : "−"}$${Math.abs(pnl.unrealizedPnlUsd).toFixed(2)}</td></tr>
<tr><td>C · Swap fees</td><td class="num neg">−$${pnl.feesUsd.toFixed(2)}</td></tr>
<tr><td>C · Slippage</td><td class="num neg">−$${pnl.slippageUsd.toFixed(2)}</td></tr>
<tr><td>C · Gas</td><td class="num neg">−$${pnl.gasUsd.toFixed(2)}</td></tr>
<tr><td><b>Final portfolio value</b></td><td class="num"><b>$${result.finalPortfolioValue.toFixed(2)}</b></td></tr>
</table>
<p class="note">Reconciliation residual: ${pnl.residual.toExponential(2)} USD.</p>

<h2>Benchmarks</h2>
<table>
<tr><th>Strategy</th><th class="num">Final value</th><th class="num">Return</th></tr>
${benchRows}
</table>

${
  result.resets.length > 0
    ? `<h2>Resets</h2>
<div class="scroll"><table>
<tr><th class="num">#</th><th>Date</th><th>Reason</th><th class="num">Price</th><th class="num">ETH</th><th class="num">Cost basis</th><th class="num">Reset P&amp;L</th><th class="num">Grid net since prev</th><th class="num">Portfolio after</th></tr>
${resetRows}
</table></div>`
    : ""
}

<script>
// Crosshair + tooltip. Data is embedded so the page stays fully self-contained.
const CHARTS = ${JSON.stringify({
    "chart-price": {
      label: "ETH price",
      unit: "$",
      series: downsample(samples.map((s) => ({ x: s.timestamp, y: s.price }))),
      scale: { x0: priceChart.scale.domainX[0], x1: priceChart.scale.domainX[1] },
    },
    "chart-equity": {
      label: "Portfolio",
      unit: "$",
      series: downsample(samples.map((s) => ({ x: s.timestamp, y: s.portfolioValue }))),
      scale: { x0: equityChart.scale.domainX[0], x1: equityChart.scale.domainX[1] },
    },
    "chart-inventory": {
      label: "ETH held",
      unit: "",
      series: downsample(samples.map((s) => ({ x: s.timestamp, y: s.eth }))),
      scale: { x0: inventoryChart.scale.domainX[0], x1: inventoryChart.scale.domainX[1] },
    },
  })};
const PAD = ${JSON.stringify(PAD)};
const VB = { w: ${W}, h: ${H} };

for (const [id, cfg] of Object.entries(CHARTS)) {
  const svg = document.getElementById(id);
  if (!svg) continue;
  const figure = svg.parentElement;
  const tip = document.createElement("div");
  tip.className = "tooltip";
  figure.appendChild(tip);
  const cross = svg.querySelector(".crosshair");
  const line = cross.querySelector("line");

  svg.addEventListener("pointermove", (event) => {
    const box = svg.getBoundingClientRect();
    const vx = ((event.clientX - box.left) / box.width) * VB.w;
    if (vx < PAD.left || vx > VB.w - PAD.right) return;
    const frac = (vx - PAD.left) / (VB.w - PAD.left - PAD.right);
    const t = cfg.scale.x0 + frac * (cfg.scale.x1 - cfg.scale.x0);
    let best = cfg.series[0];
    for (const p of cfg.series) {
      if (Math.abs(p.x - t) < Math.abs(best.x - t)) best = p;
    }
    cross.removeAttribute("hidden");
    line.setAttribute("x1", vx);
    line.setAttribute("x2", vx);
    const date = new Date(best.x * 1000).toISOString().slice(0, 16).replace("T", " ");
    const value = cfg.unit === "$"
      ? "$" + best.y.toLocaleString("en-US", { maximumFractionDigits: 2 })
      : best.y.toFixed(4);
    tip.textContent = date + "\\n" + cfg.label + ": " + value;
    tip.style.opacity = "1";
    const left = event.clientX - box.left;
    tip.style.left = Math.min(Math.max(left + 12, 8), box.width - 150) + "px";
    tip.style.top = "16px";
  });
  svg.addEventListener("pointerleave", () => {
    cross.setAttribute("hidden", "");
    tip.style.opacity = "0";
  });
}
</script>
</body>
</html>`;
}
