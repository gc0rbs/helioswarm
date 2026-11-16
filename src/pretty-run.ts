// Human-readable output for a trading run (pnpm start). --json prints the raw lines instead.
// Every line still goes to the JSON log file unchanged.
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const green = c("32");
const red = c("31");
const yellow = c("33");
const cyan = c("36");
const dim = c("2");
const bold = c("1");
const badgeRed = c("1;41;97");
const badgeYellow = c("1;43;30");
const badgeGreen = c("1;42;30");

const vis = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").length;
const pad = (s: string, n: number) => s + " ".repeat(Math.max(0, n - vis(s)));
const padL = (s: string, n: number) => " ".repeat(Math.max(0, n - vis(s))) + s;
const short = (a?: unknown) => (typeof a === "string" && a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : String(a ?? "?"));
const sol = (n: unknown) => `${Number(n).toFixed(4)} SOL`;
function num(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toFixed(2);
}
function clock(ts: unknown): string {
  const d = typeof ts === "number" ? new Date(ts) : ts ? new Date(String(ts)) : new Date();
  const t = Number.isNaN(d.getTime()) ? new Date() : d;
  return dim(`${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}:${String(t.getSeconds()).padStart(2, "0")}`);
}

const SIGNALS: Record<string, string> = {
  whale_sell: "WHALE SELL",
  holder_moved: "BIG HOLDER MOVED TOKENS",
  sell_pressure: "SELL PRESSURE",
  buy_pressure: "BUY PRESSURE",
  pending_sell: "BIG SELL INCOMING",
  pending_move: "BIG HOLDER ABOUT TO MOVE",
  pending_activity: "BIG HOLDER ACTIVE",
  note: "NOTE",
};

export function prettyRunLine(symbols: Map<string, string>): (l: Record<string, unknown>) => void {
  const sym = (m: unknown) => symbols.get(String(m)) ?? short(m);
  const agentW = 14;
  let lastRefusal = "";
  return (l) => {
    const t = clock(l.ts);
    const agent = bold(pad(String(l.agent ?? ""), agentW));
    switch (l.event) {
      case "start":
        console.log(`\n${badgeGreen(" SWARM RUNNING ")} ${l.agents} agents on ${l.mints} token${l.mints === 1 ? "" : "s"}   ${dim("Ctrl+C to stop")}\n`);
        return;
      case "wallet":
        console.log(`${t}  ${agent} ${dim(short(l.address))}  wallet ${sol(l.balanceSol)}  ${dim(`(${Number(l.tradableSol).toFixed(4)} tradable)`)}`);
        return;
      case "fill": {
        const buy = l.side === "buy";
        const tag = buy ? green(bold("BUY ")) : red(bold("SELL"));
        const amt = buy ? green(padL(sol(l.sol), 12)) : red(padL(sol(l.sol), 12));
        const link = l.sig && l.sig !== "paper" ? cyan(`solscan.io/tx/${String(l.sig).slice(0, 10)}…`) : dim("paper");
        console.log(`${t}  ${agent} ${tag} ${amt}  ${pad(`${num(Number(l.tokens))} ${sym(l.mint)}`, 16)} ${dim(String(l.reason ?? ""))}  ${link}`);
        return;
      }
      case "refused": {
        // Agents retry every tick; print each distinct refusal once until it changes.
        const key = `${l.agent}|${l.side}|${l.why}`;
        if (key === lastRefusal) return;
        lastRefusal = key;
        console.log(`${t}  ${agent} ${yellow("skip")} ${dim(`${l.side} ${sym(l.mint)}: ${l.why}`)}`);
        return;
      }
      case "alert": {
        const mv = Number(l.movePct);
        console.log(`${t}  ${agent} ${dim("price")} ${sym(l.mint)} ${mv >= 0 ? green(`+${mv.toFixed(2)}%`) : red(`${mv.toFixed(2)}%`)}`);
        return;
      }
      case "signal": {
        const label = SIGNALS[String(l.kind)] ?? String(l.kind);
        const badge = l.severity === "high" ? badgeRed(` ${label} `) : badgeYellow(` ${label} `);
        console.log(`\n${t}  ${badge} ${bold(sym(l.mint))}`);
        for (const r of (l.reasons as string[]) ?? []) console.log(`          ${r}`);
        console.log("");
        return;
      }
      case "task_error":
        console.log(`${t}  ${agent} ${red("error")} ${dim(`(${l.task})`)} ${String(l.error).slice(0, 160)}`);
        return;
      case "flow":
        return; // SWARM_LOG_FLOWS lines stay in the log file; use pnpm watch to see the market.
      case "summary": {
        const rows = (l.agents as { agent: string; preset: string; equitySol: number; pnlPct: number; trades: number; open: number }[]) ?? [];
        console.log(`\n${bold("Agents")}  ${dim("(equity = SOL + value of open positions)")}`);
        for (const r of rows) {
          const p = r.pnlPct >= 0 ? green(`+${r.pnlPct.toFixed(2)}%`) : red(`${r.pnlPct.toFixed(2)}%`);
          console.log(`  ${pad(bold(r.agent), agentW)} ${dim(pad(r.preset, 8))} ${padL(sol(r.equitySol), 13)}  ${padL(p, 8)}  ${dim(`${r.trades} trades, ${r.open} open`)}`);
        }
        console.log("");
        return;
      }
      case "stop":
        console.log(`${t}  ${dim(`stopped (${l.why})`)}`);
        return;
      default:
        console.log(`${t}  ${dim(String(l.event))} ${dim(JSON.stringify({ ...l, ts: undefined, event: undefined }))}`);
    }
  };
}
