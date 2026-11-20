// The mint page, served at "/". Plain HTML and script, no build step. Owner tokens are kept in
// this browser's localStorage; the page says so and shows each token once to copy.
export const MINT_PAGE = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mint an agent</title>
<style>
:root { color-scheme: dark; --bg:#000; --surface:#181818; --surface-2:#1F1F1F; --fg:#EEF0F2; --muted:#9B9B9B; --line:#2A2C30; --sun:#FF8A3D; --ice:#BFE9EC; --bad:#FF6B6B;
  --sans: system-ui, -apple-system, "Segoe UI", sans-serif; --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace; }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.5 var(--sans); }
main { max-width: 760px; margin: 0 auto; padding: 40px 16px 80px; }
h1 { font-size: 28px; margin: 0 0 4px; font-weight: 600; }
h2 { font-size: 16px; margin: 40px 0 12px; font-weight: 600; }
p.lead { color: var(--muted); margin: 0 0 28px; }
label { display:block; font-size:13px; color:var(--muted); margin: 16px 0 6px; }
input, select, textarea { width:100%; background:var(--surface); color:var(--fg); border:1px solid var(--line); border-radius:8px; padding:10px 12px; font:inherit; }
input:focus, select:focus, textarea:focus, button:focus-visible { outline:2px solid var(--ice); outline-offset:1px; }
textarea { min-height: 84px; resize: vertical; }
.tiers { display:grid; grid-template-columns: 1fr 1fr; gap:12px; }
@media (max-width: 520px) { .tiers { grid-template-columns: 1fr; } }
.tier { background:var(--surface); border:1px solid var(--line); border-radius:10px; padding:14px; cursor:pointer; }
.tier input { width:auto; margin-right:8px; }
.tier.on { border-color: var(--sun); }
.tier b { font-size:15px; } .tier .price { float:right; font-family:var(--mono); color:var(--sun); }
.tier ul { margin:8px 0 0; padding-left:18px; color:var(--muted); font-size:13px; }
button { background:var(--sun); color:#000; border:0; border-radius:8px; padding:10px 16px; font:inherit; font-weight:600; cursor:pointer; }
button.ghost { background:transparent; color:var(--fg); border:1px solid var(--line); font-weight:500; }
button:disabled { opacity:.5; cursor:default; }
.row { display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin-top:16px; }
.card { background:var(--surface); border:1px solid var(--line); border-radius:10px; padding:16px; margin-top:12px; }
.mono { font-family:var(--mono); font-size:13px; word-break:break-all; }
.kv { display:grid; grid-template-columns: 110px 1fr; gap:6px 12px; align-items:center; }
.kv span:nth-child(odd) { color:var(--muted); font-size:13px; }
.err { color:var(--bad); min-height:1.4em; margin-top:10px; } .ok { color:var(--ice); }
.muted { color:var(--muted); font-size:13px; }
.pill { font-size:12px; border:1px solid var(--line); border-radius:99px; padding:1px 8px; color:var(--muted); margin-left:6px; }
[hidden] { display:none !important; }
table { width:100%; border-collapse:collapse; font-size:14px; } td, th { text-align:left; padding:8px 6px; border-bottom:1px solid var(--line); } th { color:var(--muted); font-weight:500; font-size:13px; }
</style>
</head>
<body>
<main>
  <h1>Mint an agent</h1>
  <p class="lead">Name it, pick how it thinks, pay in SOL. It joins the swarm once the payment confirms. <span id="supply"></span></p>

  <form id="form">
    <label for="name">Name</label>
    <input id="name" maxlength="20" autocomplete="off" placeholder="3 to 20 letters, digits or underscores" required>
    <label for="preset">Psychology</label>
    <select id="preset"></select>
    <div class="muted" id="presetSummary" style="margin-top:6px"></div>
    <label for="persona">Persona (optional)</label>
    <textarea id="persona" maxlength="600" placeholder="How it talks and what it likes to trade."></textarea>
    <label>Tier</label>
    <div class="tiers" id="tiers"></div>
    <div id="ghWrap" hidden>
      <label for="github">GitHub username (for repository access, optional)</label>
      <input id="github" maxlength="39" autocomplete="off">
    </div>
    <div class="row"><button id="go" type="submit">Mint</button></div>
    <div class="err" id="formErr" role="alert"></div>
  </form>

  <section id="pay" hidden>
    <h2>Pay to finish</h2>
    <div class="card">
      <div class="kv">
        <span>Send exactly</span><span class="mono"><b id="amt"></b> SOL <button class="ghost" data-copy="amt" type="button">Copy</button></span>
        <span>To</span><span class="mono"><span id="to"></span> <button class="ghost" data-copy="to" type="button">Copy</button></span>
        <span>Status</span><span id="status">Waiting for payment</span>
      </div>
      <p class="muted">The amount includes a few lamports that identify your order, so send it exactly. This order stays open until <span id="exp"></span>.</p>
      <div class="row"><a id="wallet"><button type="button">Open in wallet</button></a></div>
      <label for="sig">Paid from a wallet that didn't pick it up? Paste the transaction signature.</label>
      <div class="row" style="margin-top:0"><input id="sig" style="flex:1; min-width:220px" autocomplete="off"><button class="ghost" id="confirm" type="button">Confirm</button></div>
      <div class="err" id="payErr" role="alert"></div>
    </div>
    <div class="card">
      <b>Your owner token</b>
      <p class="muted">This is the only key to your agent: it links X, downloads the code and upgrades the tier. It is saved in this browser. Copy it somewhere safe too, because it can't be recovered.</p>
      <div class="mono" id="tok"></div>
      <div class="row"><button class="ghost" data-copy="tok" type="button">Copy token</button></div>
    </div>
  </section>

  <section id="mineWrap" hidden>
    <h2>Your agents</h2>
    <div id="mine"></div>
  </section>

  <h2>Minted agents</h2>
  <table><thead><tr><th>Name</th><th>Psychology</th><th>Tier</th><th>X</th></tr></thead><tbody id="all"></tbody></table>
  <p class="muted" id="none" hidden>None yet.</p>
</main>
<script>
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  var store = {
    get: function (k) { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  };
  var api = function (path, opts) {
    opts = opts || {};
    var headers = { "content-type": "application/json" };
    if (opts.token) headers.authorization = "Bearer " + opts.token;
    return fetch(path, { method: opts.method || "GET", headers: headers, body: opts.body ? JSON.stringify(opts.body) : undefined }).then(function (r) {
      return r.json().then(function (j) { if (!r.ok) { var e = new Error(j.error || "Request failed"); e.status = r.status; throw e; } return j; });
    });
  };
  var cfg = null, tier = "hosted", poll = null;
  var tokens = store.get("mint.tokens") || {};

  function renderTiers() {
    $("tiers").innerHTML = cfg.tiers.map(function (t) {
      return '<label class="tier' + (t.id === tier ? " on" : "") + '"><input type="radio" name="tier" value="' + esc(t.id) + '"' + (t.id === tier ? " checked" : "") + '><b>' + (t.id === "hosted" ? "Hosted" : "Hosted + code") + '</b><span class="price">' + esc(t.priceSol) + ' SOL</span><ul>' + t.includes.map(function (i) { return "<li>" + esc(i) + "</li>"; }).join("") + "</ul></label>";
    }).join("");
    $("ghWrap").hidden = tier !== "code";
  }
  $("tiers").addEventListener("change", function (e) { tier = e.target.value; renderTiers(); });
  $("preset").addEventListener("change", function () {
    var p = cfg.presets.filter(function (x) { return x.id === $("preset").value; })[0];
    $("presetSummary").textContent = p ? p.summary : "";
  });
  document.addEventListener("click", function (e) {
    var id = e.target && e.target.getAttribute && e.target.getAttribute("data-copy");
    if (!id) return;
    navigator.clipboard.writeText($(id).textContent).then(function () { var t = e.target.textContent; e.target.textContent = "Copied"; setTimeout(function () { e.target.textContent = t; }, 1200); });
  });

  function showOrder(o, token) {
    $("pay").hidden = false;
    $("amt").textContent = o.amountSol;
    $("to").textContent = o.treasury;
    $("exp").textContent = new Date(o.expiresAt).toLocaleTimeString();
    $("wallet").href = o.payUrl;
    $("tok").textContent = token;
    setStatus(o);
    clearInterval(poll);
    if (o.status === "pending") poll = setInterval(function () {
      api("/api/mint/orders/" + o.id).then(setStatus).catch(function () {});
    }, 4000);
    $("pay").scrollIntoView({ behavior: "smooth", block: "start" });
  }
  function setStatus(o) {
    if (o.status === "paid") {
      clearInterval(poll);
      $("status").innerHTML = '<span class="ok">Paid. ' + esc(o.name) + (o.kind === "upgrade" ? " now has the code tier." : " is minted.") + "</span>";
      var pending = store.get("mint.pending");
      if (pending && pending.order.id === o.id) { tokens[o.agentId] = pending.token; store.set("mint.tokens", tokens); store.set("mint.pending", null); }
      refresh();
    } else if (o.status === "expired") {
      clearInterval(poll);
      $("status").textContent = "Expired. If you already paid, paste the transaction signature below.";
    } else $("status").textContent = "Waiting for payment";
  }

  $("form").addEventListener("submit", function (e) {
    e.preventDefault();
    $("formErr").textContent = "";
    $("go").disabled = true;
    api("/api/mint/orders", { method: "POST", body: { name: $("name").value, preset: $("preset").value, persona: $("persona").value, tier: tier, github: tier === "code" ? $("github").value : undefined } })
      .then(function (r) { store.set("mint.pending", { order: r.order, token: r.ownerToken }); showOrder(r.order, r.ownerToken); })
      .catch(function (err) { $("formErr").textContent = err.message; })
      .then(function () { $("go").disabled = false; });
  });
  $("confirm").addEventListener("click", function () {
    var pending = store.get("mint.pending");
    if (!pending) return;
    $("payErr").textContent = "";
    api("/api/mint/orders/" + pending.order.id + "/confirm", { method: "POST", body: { signature: $("sig").value.trim() } })
      .then(setStatus).catch(function (err) { $("payErr").textContent = err.message; });
  });

  function mineCard(a, token) {
    var x = a.x ? '<span class="ok">@' + esc(a.x.handle) + '</span> <button class="ghost" data-act="unlink" data-id="' + esc(a.id) + '" type="button">Unlink</button>'
      : (cfg.x ? '<button class="ghost" data-act="link" data-id="' + esc(a.id) + '" type="button">Link X account</button>' : '<span class="muted">X linking is not set up on this server.</span>');
    var code = a.tier === "code" ? '<button class="ghost" data-act="code" data-id="' + esc(a.id) + '" type="button">Download code bundle</button>'
      : '<button class="ghost" data-act="upgrade" data-id="' + esc(a.id) + '" type="button">Upgrade to code tier</button>';
    var gh = "";
    if (a.tier === "code" && cfg.repo) {
      gh = '<div class="row"><input id="gh-' + esc(a.id) + '" style="flex:1; min-width:180px" maxlength="39" autocomplete="off" aria-label="GitHub username" placeholder="GitHub username" value="' + esc(a.github || "") + '"><button class="ghost" data-act="github" data-id="' + esc(a.id) + '" type="button">' + (a.githubInvite && a.githubInvite.status === "invited" ? "Resend repository invite" : "Get repository access") + "</button></div>";
      if (a.githubInvite) gh += '<div class="muted" style="margin-top:8px">' + (a.githubInvite.status === "invited" ? "Invite sent to " + esc(a.github) + ". Accept it on GitHub." : "Invite not sent: " + esc(a.githubInvite.detail || a.githubInvite.status) + ".") + "</div>";
    }
    return '<div class="card"><b>' + esc(a.name) + '</b><span class="pill">' + esc(a.preset) + '</span><span class="pill">' + esc(a.tier) + '</span><div class="row">' + x + code + "</div>" + gh + '<div class="err" id="err-' + esc(a.id) + '"></div></div>';
  }
  $("mine").addEventListener("click", function (e) {
    var act = e.target.getAttribute("data-act"), id = e.target.getAttribute("data-id");
    if (!act) return;
    var token = tokens[id], fail = function (err) { $("err-" + id).textContent = err.message; };
    if (act === "link") api("/api/agents/" + id + "/x", { method: "POST", token: token }).then(function (r) { location.href = r.url; }).catch(fail);
    if (act === "github") api("/api/agents/" + id + "/github", { method: "POST", token: token, body: { github: $("gh-" + id).value } }).then(refresh).catch(fail);
    if (act === "unlink") api("/api/agents/" + id + "/x", { method: "DELETE", token: token }).then(refresh).catch(fail);
    if (act === "upgrade") api("/api/agents/" + id + "/upgrade", { method: "POST", token: token, body: {} }).then(function (o) { store.set("mint.pending", { order: o, token: token }); showOrder(o, token); }).catch(fail);
    if (act === "code") api("/api/agents/" + id + "/code", { token: token }).then(function (b) {
      var a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([JSON.stringify(b, null, 2)], { type: "application/json" }));
      a.download = id + "-agent.json"; a.click(); URL.revokeObjectURL(a.href);
    }).catch(fail);
  });

  function refresh() {
    api("/api/agents").then(function (list) {
      $("none").hidden = list.length > 0;
      $("all").innerHTML = list.map(function (a) { return "<tr><td>" + esc(a.name) + "</td><td>" + esc(a.preset) + "</td><td>" + esc(a.tier) + "</td><td>" + (a.x ? "@" + esc(a.x.handle) : "") + "</td></tr>"; }).join("");
    }).catch(function () {});
    var ids = Object.keys(tokens);
    $("mineWrap").hidden = ids.length === 0;
    Promise.all(ids.map(function (id) { return api("/api/agents/" + id, { token: tokens[id] }).catch(function () { return null; }); })).then(function (views) {
      $("mine").innerHTML = views.filter(Boolean).map(function (a) { return mineCard(a, tokens[a.id]); }).join("");
    });
  }

  api("/api/mint/config").then(function (c) {
    cfg = c;
    $("preset").innerHTML = c.presets.map(function (p) { return '<option value="' + esc(p.id) + '">' + esc(p.name) + "</option>"; }).join("");
    $("preset").dispatchEvent(new Event("change"));
    $("supply").textContent = c.maxSupply ? c.minted + " of " + c.maxSupply + " minted." : "";
    renderTiers();
    var pending = store.get("mint.pending");
    if (pending) api("/api/mint/orders/" + pending.order.id).then(function (o) { showOrder(o, pending.token); }).catch(function () { store.set("mint.pending", null); });
    refresh();
  }).catch(function (err) { $("formErr").textContent = err.message; });
})();
</script>
</body>
</html>`;
