// Puts minted agents into a swarm run, next to the groups from the config. Each minted agent
// is deployed from its own roster entry with the mint's agent template (bankroll, targets,
// tasks). Also registers "xpost": an agent with a linked X account posts its own report.
import type { GroupConfig } from "../config";
import { expandGroups, loadRoster, type AgentSpec, type RosterEntry } from "../roster";
import { registerTask } from "../tasks";
import type { PsychologyId } from "../types";
import { PSYCHOLOGIES } from "../types";

import type { MintConfig } from "./config";
import type { MintedAgent } from "./store";

export function mintedGroups(cfg: MintConfig, agents: MintedAgent[], mode: "paper" | "live" = "paper"): { groups: GroupConfig[]; roster: RosterEntry[] } {
  // An agent minted under a preset this build no longer has can't be deployed; it is skipped, not dropped from the store.
  const known = agents.filter((a) => PSYCHOLOGIES.some((p) => p.id === a.preset));
  const roster = known.map((a): RosterEntry => {
    const p = PSYCHOLOGIES.find((x) => x.id === a.preset)!;
    return { name: a.name, preset: a.preset as PsychologyId, persona: a.persona || `${p.name}: ${p.summary}` };
  });
  const groups = known.map((a): GroupConfig => {
    const posts = cfg.x.post && !!a.x;
    return {
      roster: [a.name],
      bankrollSol: cfg.agent.bankrollSol,
      targets: cfg.agent.targets,
      tasks: [...cfg.agent.tasks.filter((t) => t !== "xpost"), ...(posts ? ["xpost"] : [])],
      brain: cfg.agent.brain,
      rules: cfg.agent.rules,
      taskOptions: posts ? { xpost: { every: cfg.x.postEveryTicks, mode } } : {},
    };
  });
  return { groups, roster };
}

/** The config's own agents followed by every minted agent. */
export function expandWithMinted(groups: GroupConfig[], cfg: MintConfig, agents: MintedAgent[], mode: "paper" | "live" = "paper"): AgentSpec[] {
  const m = mintedGroups(cfg, agents, mode);
  return expandGroups([...groups, ...m.groups], [...loadRoster(), ...m.roster]);
}

export type XPoster = (agentId: string, text: string) => Promise<string>;
let poster: XPoster | null = null;

/** Wires the "xpost" task to something that can post (MintService.xPostAs). Without one, the task only logs. */
export function setXPoster(fn: XPoster | null) {
  poster = fn;
}

export function reportText(name: string, r: { equitySol: number; pnlPct: number; open: number; trades: number }, mode: unknown): string {
  const sign = r.pnlPct >= 0 ? "+" : "";
  return `${name}: equity ${r.equitySol.toFixed(4)} SOL, P&L ${sign}${r.pnlPct.toFixed(2)}%, ${r.open} open, ${r.trades} trades${mode === "live" ? "" : " (paper trading)"}`;
}

registerTask("xpost", () => ({
  name: "xpost",
  async run(ctx) {
    const every = Math.max(1, Number(ctx.options.every ?? 240));
    if (ctx.tick === 0 || ctx.tick % every !== 0) return;
    const equity = ctx.ledger.equity(ctx.agent.id, (m) => ctx.feed.latest(m)?.priceSol);
    const text = reportText(ctx.agent.name, { equitySol: equity, pnlPct: ctx.book.startSol > 0 ? (equity / ctx.book.startSol - 1) * 100 : 0, open: ctx.book.positions.size, trades: ctx.book.trades }, ctx.options.mode);
    if (!poster) return ctx.log("xpost", { posted: false, text });
    try {
      ctx.log("xpost", { posted: true, tweet: await poster(ctx.agent.name.toLowerCase(), text), text });
    } catch (e) {
      ctx.log("xpost_error", { error: (e as Error).message });
    }
  },
}));
