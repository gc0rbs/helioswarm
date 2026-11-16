// Live demo dashboard: `--dashboard [port]` on a trading run or a watch serves a page at
// http://localhost:<port> that shows the agents, their wallets and trades, the market feed,
// early (pre-execution) warnings and signals as they happen. Server-sent events, no deps.
import { createServer, type ServerResponse } from "node:http";

export interface DashboardAgent {
  id: string;
  preset: string;
  wallet?: string;
  bankrollSol: number;
}

export interface DashboardInfo {
  title: string;
  mode: "live" | "paper" | "watch";
  tokens: { mint: string; symbol: string }[];
  agents: DashboardAgent[];
}

export class Dashboard {
  private clients = new Set<ServerResponse>();
  private history: string[] = [];
  private server;

  constructor(private info: DashboardInfo, port: number) {
    this.server = createServer((req, res) => {
      const path = (req.url ?? "/").split("?")[0]!;
      if (path.endsWith("/events")) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "access-control-allow-origin": "*" });
        res.write(`event: info\ndata: ${JSON.stringify(this.info)}\n\n`);
        for (const h of this.history) res.write(h);
        this.clients.add(res);
        req.on("close", () => this.clients.delete(res));
        return;
      }
      if (path === "/" || path.endsWith("/") || path.endsWith("/live")) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(PAGE);
        return;
      }
      res.writeHead(404).end();
    });
    this.server.listen(port, "0.0.0.0", () => console.log(`\n  Dashboard: http://localhost:${port}\n`));
    const ping = setInterval(() => {
      for (const c of this.clients) c.write(": ping\n\n");
    }, 15_000);
    ping.unref();
  }

  push(line: Record<string, unknown>) {
    const msg = `data: ${JSON.stringify(line, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}\n\n`;
    this.history.push(msg);
    if (this.history.length > 600) this.history.splice(0, this.history.length - 600);
    for (const c of this.clients) c.write(msg);
  }

  close() {
    for (const c of this.clients) c.end();
    this.server.close();
  }
}

const PAGE = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Helioswarm Live</title>
<meta name="description" content="Helioswarm agents trading on Solana, live: every unit's wallet, position and trade as it happens.">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' fill='%23000000'/%3E%3Cellipse cx='16' cy='16' rx='13' ry='6' transform='rotate(-20 16 16)' fill='none' stroke='%23EEF0F2' stroke-width='1.5'/%3E%3Ccircle cx='16' cy='16' r='4' fill='%23FF8A3D'/%3E%3Crect x='25' y='9' width='4' height='4' fill='%23BFE9EC'/%3E%3C/svg%3E">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500&display=swap">
<style>
:root {
  color-scheme: dark;
  --bg: #000000; --surface: #181818; --surface-2: #1F1F1F; --fg: #EEF0F2; --muted: #9B9B9B; --dim: #5B5F66; --line: #2A2C30;
  --sun: #FF8A3D; --ice: #BFE9EC; --grid: rgba(255,255,255,0.05); --g: 96px; --pad: 16px; --top: 96px;
  --sans: "Geist", "Manrope", system-ui, -apple-system, "Segoe UI", sans-serif;
  --mono: "Geist Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  --ease: cubic-bezier(0.32, 0.72, 0, 1);
}
@media (min-width: 768px) { :root { --pad: 32px; } }
*, *::before, *::after { box-sizing: border-box; }
body { margin: 0; color: var(--fg); background: var(--bg); font-family: var(--sans); font-size: 16px; line-height: 24px; -webkit-font-smoothing: antialiased; overflow-x: hidden; position: relative; isolation: isolate; min-height: 100vh; }
body::before { content: ""; position: fixed; inset: 0; z-index: -1; pointer-events: none;
  background-image: linear-gradient(to right, var(--grid) 1px, transparent 1px), linear-gradient(to bottom, var(--grid) 1px, transparent 1px);
  background-size: var(--g) var(--g); background-position: var(--pad) var(--top); }
.grain { position: fixed; inset: 0; z-index: 40; pointer-events: none; opacity: 0.12;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='220' height='220'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 0.9 0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E"); }
a { color: inherit; }
::selection { background: var(--sun); color: var(--bg); }
.mono, .label, .num { font-family: var(--mono); }
.label { font-size: 12px; line-height: 16px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); }
.label b { font-weight: 500; color: var(--fg); }
.sun { color: var(--sun); } .ice { color: var(--ice); } .dim { color: var(--dim); } .muted { color: var(--muted); }
.wrap { padding-left: var(--pad); padding-right: var(--pad); }

/* nav */
.nav { height: var(--top); display: flex; justify-content: space-between; align-items: center; gap: 16px; }
.brand { display: flex; align-items: center; gap: 8px; text-decoration: none; font-family: var(--mono); font-weight: 500; font-size: 12px; line-height: 16px; letter-spacing: 0.08em; text-transform: uppercase; }
.btn { display: inline-flex; align-items: center; font-family: var(--mono); font-size: 12px; line-height: 16px; font-weight: 500; letter-spacing: 0.08em; text-transform: uppercase;
  padding: 8px 12px; border: 1px solid var(--line); background: rgba(0,0,0,0.6); color: var(--fg); text-decoration: none; cursor: pointer; transition: border-color 700ms var(--ease), background-color 700ms var(--ease), color 700ms var(--ease); }
.btn::before { content: "[ "; white-space: pre; } .btn::after { content: " ]"; white-space: pre; }
.btn:hover { border-color: var(--fg); }
.btn.solid { background: var(--fg); color: var(--bg); border-color: var(--fg); }
.btn.solid:hover { background: var(--sun); border-color: var(--sun); }
.status { display: inline-flex; align-items: center; gap: 8px; }
.blip { width: 8px; height: 8px; background: var(--dim); }
.on .blip { background: var(--sun); animation: blink 1.2s steps(2, start) infinite; }
@keyframes blink { to { visibility: hidden; } }

/* hero strip */
.hero { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 24px 32px; padding-bottom: 40px; border-bottom: 1px solid var(--line); }
.meta { margin: 0; font-family: var(--mono); font-size: 12px; line-height: 20px; letter-spacing: 0.04em; color: var(--dim); white-space: pre; overflow: hidden; text-overflow: ellipsis; }
.meta b { font-weight: 400; color: var(--fg); }
.clock { text-align: right; font-family: var(--mono); font-size: 12px; line-height: 20px; letter-spacing: 0.04em; display: flex; flex-direction: column; gap: 4px; align-items: flex-end; }
.clock strong { font-weight: 400; color: var(--fg); font-variant-numeric: tabular-nums; }
h1 { grid-column: 1 / -1; margin: 24px 0 0; font-size: 30px; line-height: 36px; letter-spacing: -0.01em; font-weight: 500; text-transform: uppercase; }
h1 span { display: block; color: var(--muted); }
@media (min-width: 768px) { h1 { font-size: 36px; line-height: 40px; } }
@media (min-width: 1024px) { h1 { font-size: 48px; line-height: 1; } }

/* stats */
.stats { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); border-bottom: 1px solid var(--line); }
@media (min-width: 900px) { .stats { grid-template-columns: repeat(5, minmax(0, 1fr)); } }
.stat { padding: 20px 0 20px; border-right: 1px solid var(--line); padding-left: 16px; }
.stat:first-child { padding-left: 0; }
.stat:last-child { border-right: 0; }
.stat .v { font-family: var(--mono); font-size: 24px; line-height: 32px; margin-top: 8px; font-variant-numeric: tabular-nums; white-space: nowrap; }
@media (max-width: 899px) { .stat:nth-child(2n) { border-right: 0; } .stat:nth-child(2n+1) { padding-left: 0; } .stat { border-bottom: 1px solid var(--line); } }

/* layout */
.grid { display: grid; grid-template-columns: minmax(0, 1fr); gap: 0; }
@media (min-width: 1100px) { .grid { grid-template-columns: minmax(0, 1.6fr) minmax(0, 1fr); } .grid > .col:first-child { border-right: 1px solid var(--line); padding-right: 32px; } .grid > .col:last-child { padding-left: 32px; } }
.block { padding: 32px 0; border-bottom: 1px solid var(--line); }
.block-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 16px; }
#chart { width: 100%; height: 240px; display: block; }

/* units */
.units { display: grid; grid-template-columns: repeat(auto-fill, minmax(232px, 1fr)); gap: 16px; }
.unit { border: 1px solid var(--line); background: rgba(0,0,0,0.86); padding: 12px; display: flex; flex-direction: column; gap: 8px; transition: border-color 700ms var(--ease); }
.unit.buy { border-color: var(--ice); } .unit.sell { border-color: var(--sun); }
.unit-head { display: flex; justify-content: space-between; gap: 8px; align-items: baseline; }
.unit-title { font-family: var(--mono); font-size: 14px; line-height: 20px; text-transform: uppercase; letter-spacing: 0.04em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.traits { display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; margin: 0; }
.traits dt, .traits dd { margin: 0; font-family: var(--mono); font-size: 12px; line-height: 16px; letter-spacing: 0.08em; text-transform: uppercase; }
.traits dt { color: var(--muted); }
.traits dd { color: var(--fg); text-align: right; font-variant-numeric: tabular-nums; }
.wallet { font-family: var(--mono); font-size: 12px; line-height: 16px; letter-spacing: 0.04em; color: var(--ice); text-decoration: none; }
.wallet:hover { text-decoration: underline; }
.last { font-family: var(--mono); font-size: 12px; line-height: 16px; letter-spacing: 0.04em; color: var(--dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; border-top: 1px solid var(--line); padding-top: 8px; }
.last::before { content: "> "; color: var(--sun); }
.bar { display: grid; grid-template-columns: repeat(16, 1fr); gap: 2px; }
.bar i { height: 8px; background: var(--line); }
.bar i.on { background: var(--fg); } .bar.hot i.on { background: var(--sun); }

/* feed */
.tabs { display: flex; gap: 8px; flex-wrap: wrap; }
.tabs .btn { padding: 4px 8px; }
.tabs .btn.on { border-color: var(--sun); color: var(--sun); }
.feed { max-height: 760px; overflow-y: auto; }
.ev { display: grid; grid-template-columns: 72px minmax(0, 1fr); gap: 12px; padding: 8px 0; border-bottom: 1px solid rgba(42,44,48,0.6); font-family: var(--mono); font-size: 12px; line-height: 18px; letter-spacing: 0.02em; animation: in 1.2s var(--ease); }
@keyframes in { from { background: rgba(255,138,61,0.10); } to { background: transparent; } }
.ev .t { color: var(--dim); }
.ev.market { color: var(--muted); }
.ev a { color: var(--ice); text-decoration: none; }
.ev a:hover { text-decoration: underline; }
.k { text-transform: uppercase; letter-spacing: 0.08em; }
.k.buy { color: var(--ice); } .k.sell { color: var(--sun); }
.k.buy::before { content: "[+] "; } .k.sell::before { content: "[-] "; }
.who { color: var(--fg); text-transform: uppercase; letter-spacing: 0.06em; }
.early { color: var(--sun); }
.sig { display: inline-block; padding: 0 6px; border: 1px solid var(--sun); color: var(--sun); text-transform: uppercase; letter-spacing: 0.08em; margin-right: 8px; }
.sig.low { border-color: var(--ice); color: var(--ice); }
.empty { padding: 32px 0; color: var(--dim); font-family: var(--mono); font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; }
footer { padding: 32px 0 48px; display: flex; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
</style>
</head>
<body>
<div class="grain" aria-hidden="true"></div>
<div class="wrap">
  <nav class="nav">
    <a class="brand" href="https://helioswarm.xyz/">
      <svg width="20" height="20" viewBox="0 0 32 32" aria-hidden="true"><ellipse cx="16" cy="16" rx="13" ry="6" transform="rotate(-20 16 16)" fill="none" stroke="#EEF0F2" stroke-width="1.5"/><circle cx="16" cy="16" r="4" fill="#FF8A3D"/><rect x="25" y="9" width="4" height="4" fill="#BFE9EC"/></svg>
      Helioswarm <span class="dim">/ live</span>
    </a>
    <span class="label status" id="conn"><span class="blip"></span><span id="connTxt">connecting</span></span>
  </nav>

  <header class="hero">
<pre class="meta" id="meta">SWARM ....... <b>HELIOS-01</b>
UNITS ....... <b id="mUnits">-</b>
TARGET ...... <b id="mTarget">-</b>
MODE ........ <b id="mMode">-</b></pre>
    <div class="clock">
      <strong id="clock">T+0000</strong>
      <span class="label"><span class="dim">[ ] HOLD</span>&nbsp;&nbsp;<span class="ice">[+] BUY</span>&nbsp;&nbsp;<span class="sun">[-] SELL</span></span>
    </div>
    <h1>Many minds.<span>Trading live.</span></h1>
  </header>

  <section class="stats">
    <div class="stat"><div class="label">Swarm P&amp;L</div><div class="v" id="sPnl">-</div></div>
    <div class="stat"><div class="label">Unit trades</div><div class="v" id="sTrades">0</div></div>
    <div class="stat"><div class="label">Market +/- (5m)</div><div class="v" id="sMkt">0 / 0</div></div>
    <div class="stat"><div class="label">Seen pre-exec</div><div class="v" id="sEarly">-</div></div>
    <div class="stat"><div class="label">Price (SOL)</div><div class="v" id="price">-</div></div>
  </section>

  <div class="grid">
    <div class="col">
      <section class="block">
        <div class="block-head"><span class="label"><b id="sym">-</b> / SOL &nbsp;<span id="chg"></span></span><a class="btn" id="mintLink" target="_blank" rel="noopener">Token</a></div>
        <canvas id="chart"></canvas>
      </section>
      <section class="block">
        <div class="block-head"><span class="label">Units <b id="agentCount"></b></span><span class="label dim">Own mind · own wallet · one board</span></div>
        <div class="units" id="agents"></div>
      </section>
    </div>
    <div class="col">
      <section class="block">
        <div class="block-head"><span class="label">Feed</span>
          <span class="tabs"><button class="btn on" data-f="all">All</button><button class="btn" data-f="swarm">Units</button><button class="btn" data-f="early">Pre-exec</button></span></div>
        <div class="feed" id="feed"><div class="empty">Waiting for activity…</div></div>
      </section>
    </div>
  </div>

  <footer>
    <span class="label">Every unit trades from its own public wallet. Links open on Solscan.</span>
    <span style="display:flex; gap:12px"><a class="btn" href="https://helioswarm.xyz/">Home</a><a class="btn solid" href="https://github.com/helioswarmai/helioswarm" target="_blank" rel="noopener">GitHub</a></span>
  </footer>
</div>
<script>
const $ = (id) => document.getElementById(id);
const short = (a) => a && a.length > 12 ? a.slice(0, 4) + "…" + a.slice(-4) : (a || "?");
const fmt = (n, d = 4) => Number(n).toFixed(d);
const big = (n) => { const a = Math.abs(n); return a >= 1e9 ? (n/1e9).toFixed(2)+"B" : a >= 1e6 ? (n/1e6).toFixed(2)+"M" : a >= 1e3 ? (n/1e3).toFixed(1)+"K" : n.toFixed(2); };
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const time = (ts) => { const d = ts ? new Date(ts) : new Date(); return isNaN(d) ? "" : d.toLocaleTimeString([], { hour12: false }); };
const SIG = { whale_sell: "Whale sell", holder_moved: "Holder moved", sell_pressure: "Sell pressure", buy_pressure: "Buy pressure", pending_sell: "Big sell incoming", pending_move: "Holder about to move", pending_activity: "Holder active", note: "Note" };

let info = null, filter = "all";
const agents = new Map();
const prices = [], marks = [], mkt = [], early = [];
let agentTrades = 0, lastPrice = 0, firstPrice = 0;
const t0 = Date.now();
const sym = (m) => (info?.tokens.find((t) => t.mint === m)?.symbol) || short(m);

function bar(frac, hot) {
  const n = Math.max(0, Math.min(16, Math.round(frac * 16)));
  return '<div class="bar' + (hot ? " hot" : "") + '">' + Array.from({ length: 16 }, (_, i) => '<i class="' + (i < n ? "on" : "") + '"></i>').join("") + "</div>";
}

function renderAgents() {
  const el = $("agents");
  el.innerHTML = "";
  let total = 0, start = 0;
  for (const a of agents.values()) {
    const posVal = a.tokens * lastPrice;
    const equity = a.cash + posVal;
    const pnl = equity - a.start;
    const pct = a.start > 0 ? (pnl / a.start) * 100 : 0;
    total += equity; start += a.start;
    const d = document.createElement("article");
    d.className = "unit" + (a.flash ? " " + a.flash : "");
    d.innerHTML =
      '<div class="unit-head"><span class="unit-title">' + esc(a.id) + '</span><span class="label">' + esc(a.preset) + "</span></div>" +
      (a.wallet ? '<a class="wallet" href="https://solscan.io/account/' + a.wallet + '" target="_blank" rel="noopener">' + short(a.wallet) + " ↗</a>" : '<span class="wallet dim">paper</span>') +
      '<dl class="traits"><dt>SOL</dt><dd>' + fmt(a.cash) + "</dd><dt>Holding</dt><dd>" + (a.tokens > 0 ? big(a.tokens) : "—") + "</dd><dt>P&amp;L</dt><dd class='" + (pnl >= 0 ? "ice" : "sun") + "'>" + (pnl >= 0 ? "+" : "") + fmt(pnl) + " · " + pct.toFixed(1) + "%</dd></dl>" +
      bar(equity > 0 ? posVal / equity : 0, a.flash === "sell") +
      '<div class="last">' + (a.last ? esc(a.last) : "watching") + "</div>";
    el.appendChild(d);
  }
  $("agentCount").textContent = agents.size ? String(agents.size).padStart(2, "0") : "";
  const p = total - start;
  $("sPnl").innerHTML = start ? '<span class="' + (p >= 0 ? "ice" : "sun") + '">' + (p >= 0 ? "+" : "") + fmt(p) + "</span>" : "—";
}

function drawChart() {
  const c = $("chart"), dpr = devicePixelRatio || 1, w = c.clientWidth, h = c.clientHeight;
  c.width = w * dpr; c.height = h * dpr;
  const g = c.getContext("2d"); g.scale(dpr, dpr); g.clearRect(0, 0, w, h);
  g.strokeStyle = "rgba(255,255,255,0.05)"; g.lineWidth = 1;
  for (let y = 0.5; y < h; y += 48) { g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); }
  const now = Date.now(), from = now - 10 * 60_000;
  const pts = prices.filter((p) => p.t >= from);
  if (pts.length < 2) { g.fillStyle = "#5B5F66"; g.font = "12px 'Geist Mono', monospace"; g.fillText("WAITING FOR TRADES…", 0, h / 2); return; }
  let lo = Math.min(...pts.map((p) => p.p)), hi = Math.max(...pts.map((p) => p.p));
  if (hi === lo) { hi *= 1.01; lo *= 0.99; }
  const x = (t) => ((t - from) / (now - from)) * (w - 8) + 4;
  const y = (p) => 12 + (1 - (p - lo) / (hi - lo)) * (h - 24);
  g.beginPath(); pts.forEach((p, i) => i ? g.lineTo(x(p.t), y(p.p)) : g.moveTo(x(p.t), y(p.p)));
  g.strokeStyle = "#EEF0F2"; g.lineWidth = 1.5; g.stroke();
  for (const m of marks.filter((m) => m.t >= from)) {
    const s = 7; g.fillStyle = m.side === "buy" ? "#BFE9EC" : "#FF8A3D"; g.fillRect(x(m.t) - s / 2, y(m.p) - s / 2, s, s);
  }
  const last = pts[pts.length - 1];
  g.fillStyle = "#FF8A3D"; g.fillRect(x(last.t) - 3, y(last.p) - 3, 6, 6);
}

function add(cls, html, ts, kind) {
  const feed = $("feed");
  if (feed.firstElementChild?.classList.contains("empty")) feed.innerHTML = "";
  const d = document.createElement("div");
  d.className = "ev " + cls;
  d.dataset.kind = kind;
  d.innerHTML = '<span class="t">' + time(ts) + "</span><span>" + html + "</span>";
  if (filter !== "all" && kind !== filter) d.style.display = "none";
  feed.prepend(d);
  while (feed.children.length > 400) feed.lastChild.remove();
}

function stats() {
  const cut = Date.now() - 5 * 60_000;
  while (mkt.length && mkt[0].t < cut) mkt.shift();
  $("sMkt").innerHTML = '<span class="ice">' + mkt.filter((m) => m.s === "buy").length + '</span> / <span class="sun">' + mkt.filter((m) => m.s === "sell").length + "</span>";
  const e = early.slice(-200).sort((a, b) => a - b);
  $("sEarly").textContent = e.length ? e[Math.floor(e.length / 2)] + "ms" : "—";
  $("sTrades").textContent = String(agentTrades).padStart(2, "0");
  if (lastPrice) {
    $("price").textContent = lastPrice.toPrecision(4);
    if (firstPrice) { const c = (lastPrice / firstPrice - 1) * 100; $("chg").innerHTML = '<span class="' + (c >= 0 ? "ice" : "sun") + '">' + (c >= 0 ? "+" : "") + c.toFixed(2) + "%</span>"; }
  }
  const s = Math.floor((Date.now() - t0) / 1000);
  $("clock").textContent = "T+" + String(Math.floor(s / 60)).padStart(4, "0");
}

function onEvent(l) {
  const ts = l.ts;
  switch (l.event) {
    case "wallet": {
      const a = agents.get(l.agent); if (!a) return;
      a.cash = Number(l.tradableSol); a.start = a.cash; a.wallet = l.address || a.wallet; renderAgents(); return;
    }
    case "fill": {
      const a = agents.get(l.agent);
      const buy = l.side === "buy";
      agentTrades++;
      if (a) {
        if (buy) { a.cash -= Number(l.sol); a.tokens += Number(l.tokens); } else { a.cash += Number(l.sol); a.tokens = Math.max(0, a.tokens - Number(l.tokens)); }
        a.last = (buy ? "bought " : "sold ") + fmt(l.sol) + " SOL" + (l.reason && l.reason !== "on-chain" ? " · " + l.reason : "");
        a.flash = buy ? "buy" : "sell"; setTimeout(() => { a.flash = null; renderAgents(); }, 1800);
      }
      if (l.priceSol) { lastPrice = Number(l.priceSol); if (!firstPrice) firstPrice = lastPrice; marks.push({ t: Date.now(), p: lastPrice, side: l.side }); prices.push({ t: Date.now(), p: lastPrice }); }
      const link = l.sig && l.sig !== "paper" ? ' <a href="https://solscan.io/tx/' + l.sig + '" target="_blank" rel="noopener">tx ↗</a>' : ' <span class="dim">paper</span>';
      add("swarm", '<span class="who">' + esc(l.agent) + '</span> <span class="k ' + (buy ? "buy" : "sell") + '">' + (buy ? "buy" : "sell") + "</span> " + fmt(l.sol) + " SOL <span class='dim'>" + big(Number(l.tokens)) + " " + esc(sym(l.mint)) + (l.reason && l.reason !== "on-chain" ? " · " + esc(l.reason) : "") + "</span>" + link, ts, "swarm");
      renderAgents(); stats(); return;
    }
    case "refused": { const a = agents.get(l.agent); if (a) { a.last = "skip: " + l.why; renderAgents(); } return; }
    case "signal": {
      add("", '<span class="sig ' + (l.severity === "high" ? "" : "low") + '">' + esc(SIG[l.kind] || l.kind) + "</span>" + esc((l.reasons || []).join(" · ")), ts, "swarm");
      return;
    }
    case "flow": {
      if (l.kind !== "buy" && l.kind !== "sell") return;
      const buy = l.kind === "buy";
      if (l.priceSol) { lastPrice = Number(l.priceSol); if (!firstPrice) firstPrice = lastPrice; prices.push({ t: Date.now(), p: lastPrice }); if (prices.length > 4000) prices.shift(); }
      mkt.push({ t: Date.now(), s: l.kind });
      if (l.seenEarlyMs != null && l.seenEarlyMs >= 0) early.push(l.seenEarlyMs);
      const e = l.seenEarlyMs != null && l.seenEarlyMs >= 0 ? ' <span class="early">⚡' + l.seenEarlyMs + "ms</span>" : "";
      add("market", '<span class="k ' + (buy ? "buy" : "sell") + '">' + (buy ? "buy" : "sell") + "</span> " + fmt(l.sol) + " SOL <span class='dim'>" + big(Number(l.tokens)) + " · " + short(l.owner) + "</span>" + e, ts, "market");
      stats(); return;
    }
    case "pending": {
      if (l.kind !== "buy" && l.kind !== "sell") return;
      add("market", '<span class="early">⏳ incoming</span> <span class="k ' + l.kind + '">' + l.kind + '</span> <span class="dim">' + short(l.owner) + " · " + esc(l.venue) + " · not executed yet</span>", ts, "early");
      return;
    }
    case "task_error": { const a = agents.get(l.agent); if (a) { a.last = "error: " + String(l.error).slice(0, 80); renderAgents(); } return; }
  }
}

function connect() {
  const es = new EventSource("events");
  es.addEventListener("info", (m) => {
    info = JSON.parse(m.data);
    agents.clear();
    for (const a of info.agents) agents.set(a.id, { ...a, cash: a.bankrollSol, start: a.bankrollSol, tokens: 0, last: "" });
    const t = info.tokens[0];
    if (t) { $("sym").textContent = t.symbol || short(t.mint); $("mTarget").textContent = (t.symbol || "") + " " + short(t.mint); $("mintLink").href = "https://solscan.io/token/" + t.mint; }
    const presets = new Set(info.agents.map((a) => a.preset));
    $("mUnits").textContent = info.agents.length + " / " + presets.size + " CLASSES";
    $("mMode").innerHTML = info.mode === "live" ? '<span class="sun">LIVE · REAL SOL</span>' : info.mode === "paper" ? "PAPER" : "WATCH";
    $("feed").innerHTML = '<div class="empty">Waiting for activity…</div>';
    renderAgents();
  });
  es.onmessage = (m) => onEvent(JSON.parse(m.data));
  es.onopen = () => { $("conn").classList.add("on"); $("connTxt").textContent = "live"; };
  es.onerror = () => { $("conn").classList.remove("on"); $("connTxt").textContent = "reconnecting"; };
}
document.querySelectorAll(".tabs .btn").forEach((b) => b.onclick = () => {
  document.querySelectorAll(".tabs .btn").forEach((x) => x.classList.toggle("on", x === b));
  filter = b.dataset.f;
  for (const ev of $("feed").children) ev.style.display = filter === "all" || ev.dataset.kind === filter ? "" : "none";
});
setInterval(() => { drawChart(); stats(); }, 1000);
addEventListener("resize", drawChart);
connect();
</script>
</body>
</html>`;
