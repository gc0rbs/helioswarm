// Human-readable output for --watch. One line per trade, early warnings and signals
// highlighted, and a short summary every 30s. Use --json for the raw event stream.
import type { Signal } from "./board";

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const green = c("32");
const red = c("31");
const yellow = c("33");
const cyan = c("36");
const dim = c("2");
const bold = c("1");
const inverseRed = c("1;41;97");
const inverseYellow = c("1;43;30");

const short = (a?: string) => (a ? `${a.slice(0, 4)}…${a.slice(-4)}` : "?");
const time = () => {
  const d = new Date();
  return dim(`${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}.${String(d.getMilliseconds()).padStart(3, "0")}`);
};
const pad = (s: string, n: number) => s + " ".repeat(Math.max(0, n - s.replace(/\x1b\[[0-9;]*m/g, "").length));

function num(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toFixed(a >= 1 ? 2 : 4);
}
const sol = (n: number) => `${n.toFixed(n >= 1 ? 2 : 4)} SOL`;

const SIGNAL_LABEL: Record<string, string> = {
  whale_sell: "WHALE SELL",
  holder_moved: "BIG HOLDER MOVED TOKENS",
  sell_pressure: "SELL PRESSURE",
  buy_pressure: "BUY PRESSURE",
  pending_sell: "BIG SELL INCOMING",
  pending_move: "BIG HOLDER ABOUT TO MOVE TOKENS",
  pending_activity: "BIG HOLDER ACTIVE",
  note: "NOTE",
};

export class PrettyWatch {
  private stats = { buys: 0, sells: 0, buySol: 0, sellSol: 0, executed: new Set<string>(), early: [] as number[], pending: 0 };
  private lastPrice = new Map<string, number>();
  private landed = new Set<string>();
  private timer: NodeJS.Timeout;

  constructor(private symbols: Map<string, string>, private decimals: (mint: string) => number) {
    this.timer = setInterval(() => this.summary(), 30_000);
    this.timer.unref();
  }

  header(mints: string[]) {
    console.log("");
    for (const m of mints) console.log(`${bold("Watching")} ${bold(cyan(this.symbols.get(m) ?? short(m)))}  ${dim(m)}`);
    console.log(dim(`${green("BUY")}/${red("SELL")} = executed trade   ${yellow("⏳")} = incoming, not executed yet   ⚡ = how early we saw it   Ctrl+C to stop`));
    console.log("");
  }

  status(msg: string) {
    console.log(dim(`· ${msg}`));
  }

  private sym(mint: unknown) {
    return this.symbols.get(String(mint)) ?? short(String(mint));
  }

  event(l: Record<string, unknown>) {
    const kind = String(l.kind);
    if (l.event === "flow") {
      const tokens = Number(l.tokens);
      if (kind === "buy" || kind === "sell") {
        const isBuy = kind === "buy";
        const solAmt = Number(l.sol);
        const sig = String(l.sig);
        this.stats.executed.add(sig);
        this.landed.add(sig);
        if (this.landed.size > 5_000) this.landed.delete(this.landed.values().next().value!);
        if (isBuy) (this.stats.buys++, (this.stats.buySol += solAmt));
        else (this.stats.sells++, (this.stats.sellSol += solAmt));
        if (l.priceSol) this.lastPrice.set(String(l.mint), Number(l.priceSol));
        const early = l.seenEarlyMs != null ? Number(l.seenEarlyMs) : undefined;
        if (early != null && early >= 0) this.stats.early.push(early);
        const tag = isBuy ? green(bold(pad("BUY", 5))) : red(bold(pad("SELL", 5)));
        const amt = isBuy ? green(pad(sol(solAmt), 12)) : red(pad(sol(solAmt), 12));
        const lead = early != null && early >= 0 ? cyan(`⚡ ${early}ms early`) : "";
        console.log(`${time()}  ${tag} ${amt} ${pad(`${num(tokens)} ${this.sym(l.mint)}`, 18)} ${dim(short(String(l.owner)))}  ${lead}`);
        return;
      }
      // Transfers: print the sending side once (the receiving side is the same transfer).
      if (kind === "transfer_out") {
        console.log(`${time()}  ${dim(pad("MOVE", 5))} ${pad(`${num(tokens)} ${this.sym(l.mint)}`, 31)} ${dim(`${short(String(l.owner))} → ${short(l.counterparty as string | undefined)}`)}`);
      }
      return;
    }
    if (l.event === "pending") {
      // Router trades decode only as "activity" (direction unknown): the executed line follows
      // with its ⚡ timing, so skip them here. Also skip anything that already landed.
      if (kind === "activity" || this.landed.has(String(l.sig))) return;
      this.stats.pending++;
      const raw = l.amountRaw != null ? Number(BigInt(String(l.amountRaw))) / 10 ** this.decimals(String(l.mint)) : undefined;
      const amount = raw != null ? `${kind === "buy" ? "≥" : ""}${num(raw)} ${this.sym(l.mint)}` : `? ${this.sym(l.mint)}`;
      const label = kind === "sell" ? red("sell") : kind === "buy" ? green("buy") : kind === "move" ? "move" : dim("activity");
      const to = l.to ? dim(` → ${short(String(l.to))}`) : "";
      console.log(`${time()}  ${yellow("⏳")} ${dim("incoming")} ${pad(label, 8)} ${pad(amount, 18)} ${dim(short(String(l.owner)))}${to}  ${dim(`(${l.venue})`)}`);
    }
  }

  signal(s: Signal) {
    const label = SIGNAL_LABEL[s.kind] ?? s.kind;
    const badge = s.severity === "high" ? inverseRed(` ${label} `) : inverseYellow(` ${label} `);
    console.log("");
    console.log(`${time()}  ${badge} ${bold(this.sym(s.mint))}`);
    for (const r of s.reasons) console.log(`               ${r}`);
    console.log("");
  }

  summary() {
    const s = this.stats;
    if (!s.buys && !s.sells && !s.pending) return;
    const caught = s.early.length;
    const total = s.executed.size;
    const median = caught ? [...s.early].sort((a, b) => a - b)[Math.floor(caught / 2)] : undefined;
    const net = s.buySol - s.sellSol;
    const price = [...this.lastPrice].map(([m, p]) => `${this.sym(m)} ${p.toPrecision(3)} SOL`).join(", ");
    console.log(
      dim("── last 30s ── ") +
        `${green(`${s.buys} buys ${sol(s.buySol)}`)}  ${red(`${s.sells} sells ${sol(s.sellSol)}`)}  net ${net >= 0 ? green(sol(net)) : red(sol(net))}` +
        dim(`  │  seen early ${caught}/${total}${median != null ? `, median ${median}ms` : ""}${price ? `  │  ${price}` : ""}`),
    );
    this.stats = { buys: 0, sells: 0, buySol: 0, sellSol: 0, executed: new Set(), early: [], pending: 0 };
  }

  stop() {
    clearInterval(this.timer);
    this.summary();
  }
}
