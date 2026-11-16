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
      if (req.url === "/events") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "access-control-allow-origin": "*" });
        res.write(`event: info\ndata: ${JSON.stringify(this.info)}\n\n`);
        for (const h of this.history) res.write(h);
        this.clients.add(res);
        req.on("close", () => this.clients.delete(res));
        return;
      }
      if (req.url === "/" || req.url?.startsWith("/?")) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(PAGE);
        return;
      }
      res.writeHead(404).end();
    });
    this.server.listen(port, () => console.log(`\n  Dashboard: http://localhost:${port}\n`));
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
<title>HelioSwarm Live</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #07080c; --panel: #0e1017; --panel2: #131621; --line: #1d2130; --text: #e8eaf2; --muted: #7d8399;
    --green: #2ee59d; --red: #ff5c7a; --amber: #ffb547; --cyan: #5cc8ff; --accent: #ff8a3d;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.45 Inter, system-ui, sans-serif; }
  .mono { font-family: "JetBrains Mono", ui-monospace, monospace; }
  header { display: flex; align-items: center; gap: 16px; padding: 18px 28px; border-bottom: 1px solid var(--line); position: sticky; top: 0; background: rgba(7,8,12,.92); backdrop-filter: blur(8px); z-index: 2; flex-wrap: wrap; }
  .brand { font-weight: 700; font-size: 18px; letter-spacing: -.01em; }
  .brand span { background: linear-gradient(90deg, #ffb547, #ff5c7a); -webkit-background-clip: text; background-clip: text; color: transparent; }
  .pill { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 999px; background: var(--panel2); border: 1px solid var(--line); font-size: 12px; color: var(--muted); }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); }
  .live .dot { background: var(--green); box-shadow: 0 0 0 0 rgba(46,229,157,.6); animation: pulse 1.6s infinite; }
  @keyframes pulse { 70% { box-shadow: 0 0 0 8px rgba(46,229,157,0); } 100% { box-shadow: 0 0 0 0 rgba(46,229,157,0); } }
  .token { margin-left: auto; text-align: right; }
  .token b { font-size: 16px; }
  .token a { color: var(--muted); font-size: 12px; text-decoration: none; }
  main { padding: 22px 28px 40px; display: grid; gap: 18px; grid-template-columns: minmax(0, 1.55fr) minmax(0, 1fr); max-width: 1500px; margin: 0 auto; }
  @media (max-width: 1000px) { main { grid-template-columns: 1fr; padding: 16px; } header { padding: 14px 16px; } }
  .stats { grid-column: 1 / -1; display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 12px; }
  @media (max-width: 800px) { .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  .stat { background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 14px 16px; }
  .stat .k { color: var(--muted); font-size: 12px; }
  .stat .v { font-size: 22px; font-weight: 600; margin-top: 4px; font-variant-numeric: tabular-nums; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 16px; overflow: hidden; }
  .card h2 { margin: 0; font-size: 13px; font-weight: 600; color: var(--muted); padding: 14px 16px; border-bottom: 1px solid var(--line); display: flex; justify-content: space-between; align-items: center; }
  #chart { width: 100%; height: 220px; display: block; }
  .agents { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 12px; padding: 14px; }
  .agent { background: var(--panel2); border: 1px solid var(--line); border-radius: 12px; padding: 12px 14px; transition: border-color .4s, box-shadow .4s; }
  .agent.flash-buy { border-color: var(--green); box-shadow: 0 0 0 1px var(--green) inset; }
  .agent.flash-sell { border-color: var(--red); box-shadow: 0 0 0 1px var(--red) inset; }
  .agent .top { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
  .agent .name { font-weight: 600; }
  .agent .preset { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: .06em; }
  .agent .wallet { font-size: 11px; color: var(--cyan); text-decoration: none; }
  .agent .row { display: flex; justify-content: space-between; font-size: 12px; color: var(--muted); margin-top: 6px; font-variant-numeric: tabular-nums; }
  .agent .row b { color: var(--text); font-weight: 500; }
  .agent .last { margin-top: 8px; font-size: 12px; color: var(--muted); min-height: 18px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .feed { height: 640px; overflow-y: auto; padding: 6px 0; }
  .ev { display: grid; grid-template-columns: 62px 1fr; gap: 10px; padding: 7px 16px; font-size: 13px; border-bottom: 1px solid rgba(29,33,48,.5); animation: in .35s ease-out; }
  @keyframes in { from { background: rgba(255,181,71,.08); } to { background: transparent; } }
  .ev .t { color: var(--muted); font-size: 11px; padding-top: 2px; }
  .ev.market { opacity: .62; }
  .ev.swarm { background: rgba(255,138,61,.05); }
  .tag { display: inline-block; font-size: 10px; font-weight: 700; letter-spacing: .05em; padding: 2px 6px; border-radius: 5px; margin-right: 6px; vertical-align: 1px; }
  .buy { color: var(--green); } .sell { color: var(--red); }
  .tag.buy { background: rgba(46,229,157,.12); } .tag.sell { background: rgba(255,92,122,.12); }
  .tag.early { color: var(--amber); background: rgba(255,181,71,.12); }
  .tag.agent { color: var(--accent); background: rgba(255,138,61,.14); }
  .tag.sig { color: #111; background: var(--amber); } .tag.sig.high { background: var(--red); color: #fff; }
  .ev a { color: var(--cyan); text-decoration: none; }
  .muted { color: var(--muted); }
  .tabs { display: flex; gap: 6px; }
  .tabs button { background: transparent; border: 1px solid var(--line); color: var(--muted); border-radius: 8px; padding: 3px 9px; font: inherit; font-size: 12px; cursor: pointer; }
  .tabs button.on { color: var(--text); border-color: var(--accent); }
  .empty { padding: 30px 16px; color: var(--muted); text-align: center; }
</style>
</head>
<body>
<header>
  <div class="brand"><span>HelioSwarm</span> Live</div>
  <div class="pill" id="conn"><span class="dot"></span><span id="connTxt">connecting</span></div>
  <div class="pill" id="mode">-</div>
  <div class="token"><b id="sym">-</b> <span class="mono" id="price">-</span><br><a id="mintLink" target="_blank" rel="noopener" class="mono"></a></div>
</header>
<main>
  <section class="stats">
    <div class="stat"><div class="k">Swarm P&amp;L</div><div class="v mono" id="sPnl">-</div></div>
    <div class="stat"><div class="k">Agent trades</div><div class="v mono" id="sTrades">0</div></div>
    <div class="stat"><div class="k">Market buys / sells (5m)</div><div class="v mono" id="sMkt">0 / 0</div></div>
    <div class="stat"><div class="k">Seen before execution</div><div class="v mono" id="sEarly">-</div></div>
    <div class="stat"><div class="k">Warnings</div><div class="v mono" id="sSig">0</div></div>
  </section>
  <div style="display:grid; gap:18px; align-content:start; min-width:0">
    <section class="card"><h2>Price <span class="mono muted" id="chg"></span></h2><canvas id="chart"></canvas></section>
    <section class="card"><h2>Agents <span class="muted" id="agentCount"></span></h2><div class="agents" id="agents"></div></section>
  </div>
  <section class="card" style="min-width:0">
    <h2>Live feed <span class="tabs"><button data-f="all" class="on">All</button><button data-f="swarm">Agents</button><button data-f="early">Early</button></span></h2>
    <div class="feed" id="feed"><div class="empty">Waiting for activity…</div></div>
  </section>
</main>
<script>
const $ = (id) => document.getElementById(id);
const short = (a) => a && a.length > 12 ? a.slice(0, 4) + "…" + a.slice(-4) : (a || "?");
const fmt = (n, d = 4) => Number(n).toFixed(d);
const big = (n) => { const a = Math.abs(n); return a >= 1e9 ? (n/1e9).toFixed(2)+"B" : a >= 1e6 ? (n/1e6).toFixed(2)+"M" : a >= 1e3 ? (n/1e3).toFixed(1)+"K" : n.toFixed(2); };
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const time = (ts) => { const d = ts ? new Date(ts) : new Date(); return isNaN(d) ? "" : d.toLocaleTimeString([], { hour12: false }); };
const SIG = { whale_sell: "WHALE SELL", holder_moved: "HOLDER MOVED", sell_pressure: "SELL PRESSURE", buy_pressure: "BUY PRESSURE", pending_sell: "BIG SELL INCOMING", pending_move: "HOLDER ABOUT TO MOVE", pending_activity: "HOLDER ACTIVE", note: "NOTE" };

let info = null, filter = "all";
const agents = new Map();
const prices = [];
const mkt = [];
const early = [];
let agentTrades = 0, warnings = 0, lastPrice = 0, firstPrice = 0;
const sym = (m) => (info?.tokens.find((t) => t.mint === m)?.symbol) || short(m);

function renderAgents() {
  const el = $("agents");
  el.innerHTML = "";
  for (const a of agents.values()) {
    const equity = a.cash + a.tokens * lastPrice;
    const pnl = equity - a.start;
    const pct = a.start > 0 ? (pnl / a.start) * 100 : 0;
    const d = document.createElement("div");
    d.className = "agent" + (a.flash ? " flash-" + a.flash : "");
    d.innerHTML = \`<div class="top"><span class="name">\${esc(a.id)}</span><span class="preset">\${esc(a.preset)}</span></div>
      \${a.wallet ? \`<a class="wallet mono" href="https://solscan.io/account/\${a.wallet}" target="_blank" rel="noopener">\${short(a.wallet)} ↗</a>\` : '<span class="wallet muted">paper</span>'}
      <div class="row"><span>SOL</span><b class="mono">\${fmt(a.cash)}</b></div>
      <div class="row"><span>Holding</span><b class="mono">\${a.tokens > 0 ? big(a.tokens) + " " + esc(sym(info.tokens[0]?.mint)) : "-"}</b></div>
      <div class="row"><span>P&amp;L</span><b class="mono \${pnl >= 0 ? "buy" : "sell"}">\${pnl >= 0 ? "+" : ""}\${fmt(pnl)} (\${pct.toFixed(1)}%)</b></div>
      <div class="last">\${a.last ? esc(a.last) : "watching…"}</div>\`;
    el.appendChild(d);
  }
  $("agentCount").textContent = agents.size ? agents.size + " agents" : "";
  let total = 0, start = 0;
  for (const a of agents.values()) { total += a.cash + a.tokens * lastPrice; start += a.start; }
  const p = total - start;
  $("sPnl").innerHTML = start ? \`<span class="\${p >= 0 ? "buy" : "sell"}">\${p >= 0 ? "+" : ""}\${fmt(p)} SOL</span>\` : "-";
}

function drawChart() {
  const c = $("chart"), dpr = devicePixelRatio || 1, w = c.clientWidth, h = c.clientHeight;
  c.width = w * dpr; c.height = h * dpr;
  const g = c.getContext("2d"); g.scale(dpr, dpr); g.clearRect(0, 0, w, h);
  if (prices.length < 2) { g.fillStyle = "#7d8399"; g.font = "13px Inter"; g.fillText("Waiting for trades…", 16, h / 2); return; }
  const now = Date.now(), from = now - 10 * 60_000;
  const pts = prices.filter((p) => p.t >= from);
  if (pts.length < 2) return;
  let lo = Math.min(...pts.map((p) => p.p)), hi = Math.max(...pts.map((p) => p.p));
  if (hi === lo) { hi *= 1.01; lo *= 0.99; }
  const x = (t) => 12 + ((t - from) / (now - from)) * (w - 24);
  const y = (p) => 14 + (1 - (p - lo) / (hi - lo)) * (h - 28);
  const up = pts[pts.length - 1].p >= pts[0].p;
  const grad = g.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, up ? "rgba(46,229,157,.25)" : "rgba(255,92,122,.25)"); grad.addColorStop(1, "rgba(0,0,0,0)");
  g.beginPath(); pts.forEach((p, i) => i ? g.lineTo(x(p.t), y(p.p)) : g.moveTo(x(p.t), y(p.p)));
  g.lineTo(x(pts[pts.length - 1].t), h); g.lineTo(x(pts[0].t), h); g.closePath(); g.fillStyle = grad; g.fill();
  g.beginPath(); pts.forEach((p, i) => i ? g.lineTo(x(p.t), y(p.p)) : g.moveTo(x(p.t), y(p.p)));
  g.strokeStyle = up ? "#2ee59d" : "#ff5c7a"; g.lineWidth = 2; g.stroke();
  for (const m of marks.filter((m) => m.t >= from)) {
    g.beginPath(); g.arc(x(m.t), y(m.p), 5, 0, 7); g.fillStyle = m.side === "buy" ? "#2ee59d" : "#ff5c7a"; g.fill();
    g.strokeStyle = "#07080c"; g.lineWidth = 2; g.stroke();
  }
}
const marks = [];

function add(cls, html, ts, kind) {
  const feed = $("feed");
  if (feed.firstElementChild?.classList.contains("empty")) feed.innerHTML = "";
  const d = document.createElement("div");
  d.className = "ev " + cls;
  d.dataset.kind = kind;
  d.innerHTML = \`<span class="t mono">\${time(ts)}</span><span>\${html}</span>\`;
  if (filter !== "all" && kind !== filter) d.style.display = "none";
  feed.prepend(d);
  while (feed.children.length > 400) feed.lastChild.remove();
}

function stats() {
  const cut = Date.now() - 5 * 60_000;
  while (mkt.length && mkt[0].t < cut) mkt.shift();
  $("sMkt").innerHTML = \`<span class="buy">\${mkt.filter((m) => m.s === "buy").length}</span> / <span class="sell">\${mkt.filter((m) => m.s === "sell").length}</span>\`;
  const e = early.slice(-200).sort((a, b) => a - b);
  $("sEarly").textContent = e.length ? \`\${e[Math.floor(e.length / 2)]}ms early\` : "-";
  $("sTrades").textContent = agentTrades;
  $("sSig").textContent = warnings;
  if (lastPrice) {
    $("price").textContent = lastPrice.toPrecision(4) + " SOL";
    if (firstPrice) { const c = ((lastPrice / firstPrice) - 1) * 100; $("chg").innerHTML = \`<span class="\${c >= 0 ? "buy" : "sell"}">\${c >= 0 ? "+" : ""}\${c.toFixed(2)}%</span> since open\`; }
  }
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
        a.last = (buy ? "Bought " : "Sold ") + fmt(l.sol) + " SOL · " + (l.reason || "");
        a.flash = buy ? "buy" : "sell"; setTimeout(() => { a.flash = null; renderAgents(); }, 1500);
      }
      if (l.priceSol) { lastPrice = Number(l.priceSol); marks.push({ t: Date.now(), p: lastPrice, side: l.side }); }
      const link = l.sig && l.sig !== "paper" ? \` <a href="https://solscan.io/tx/\${l.sig}" target="_blank" rel="noopener">tx ↗</a>\` : ' <span class="muted">(paper)</span>';
      add("swarm", \`<span class="tag agent">\${esc(l.agent)}</span><span class="tag \${buy ? "buy" : "sell"}">\${buy ? "BUY" : "SELL"}</span><b class="mono \${buy ? "buy" : "sell"}">\${fmt(l.sol)} SOL</b> <span class="muted">\${big(Number(l.tokens))} \${esc(sym(l.mint))} · \${esc(l.reason || "")}</span>\${link}\`, ts, "swarm");
      renderAgents(); stats(); return;
    }
    case "refused": {
      const a = agents.get(l.agent); if (a) { a.last = "Skipped: " + l.why; renderAgents(); } return;
    }
    case "signal": {
      warnings++;
      add("", \`<span class="tag sig \${l.severity === "high" ? "high" : ""}">\${SIG[l.kind] || l.kind}</span>\${esc((l.reasons || []).join(" · "))}\`, ts, "swarm");
      stats(); return;
    }
    case "flow": {
      if (l.kind !== "buy" && l.kind !== "sell") return;
      const buy = l.kind === "buy";
      if (l.priceSol) { lastPrice = Number(l.priceSol); if (!firstPrice) firstPrice = lastPrice; prices.push({ t: Date.now(), p: lastPrice }); if (prices.length > 3000) prices.shift(); }
      mkt.push({ t: Date.now(), s: l.kind });
      if (l.seenEarlyMs != null && l.seenEarlyMs >= 0) early.push(l.seenEarlyMs);
      const e = l.seenEarlyMs != null && l.seenEarlyMs >= 0 ? \` <span class="tag early">⚡ \${l.seenEarlyMs}ms early</span>\` : "";
      add("market", \`<span class="tag \${buy ? "buy" : "sell"}">\${buy ? "BUY" : "SELL"}</span><span class="mono">\${fmt(l.sol)} SOL</span> <span class="muted">\${big(Number(l.tokens))} \${esc(sym(l.mint))} · \${short(l.owner)}</span>\${e}\`, ts, "market");
      stats(); return;
    }
    case "pending": {
      if (l.kind !== "buy" && l.kind !== "sell") return;
      add("market", \`<span class="tag early">⏳ INCOMING</span><span class="\${l.kind}">\${l.kind}</span> <span class="muted">by \${short(l.owner)} on \${esc(l.venue)} · not executed yet</span>\`, ts, "early");
      return;
    }
    case "task_error": {
      const a = agents.get(l.agent); if (a) { a.last = "Error: " + String(l.error).slice(0, 80); renderAgents(); } return;
    }
  }
}

function connect() {
  const es = new EventSource("/events");
  es.addEventListener("info", (m) => {
    info = JSON.parse(m.data);
    agents.clear();
    for (const a of info.agents) agents.set(a.id, { ...a, cash: a.bankrollSol, start: a.bankrollSol, tokens: 0, last: "" });
    const t = info.tokens[0];
    if (t) { $("sym").textContent = t.symbol || short(t.mint); $("mintLink").textContent = t.mint; $("mintLink").href = "https://solscan.io/token/" + t.mint; }
    $("mode").textContent = info.mode === "live" ? "LIVE · real SOL" : info.mode === "paper" ? "Paper trading" : "Watching";
    $("feed").innerHTML = '<div class="empty">Waiting for activity…</div>';
    renderAgents();
  });
  es.onmessage = (m) => onEvent(JSON.parse(m.data));
  es.onopen = () => { $("conn").classList.add("live"); $("connTxt").textContent = "live"; };
  es.onerror = () => { $("conn").classList.remove("live"); $("connTxt").textContent = "reconnecting"; };
}
document.querySelectorAll(".tabs button").forEach((b) => b.onclick = () => {
  document.querySelectorAll(".tabs button").forEach((x) => x.classList.toggle("on", x === b));
  filter = b.dataset.f;
  for (const ev of $("feed").children) ev.style.display = filter === "all" || ev.dataset.kind === filter ? "" : "none";
});
setInterval(() => { drawChart(); stats(); }, 1000);
addEventListener("resize", drawChart);
connect();
</script>
</body>
</html>`;
