// Minting agents. Someone picks a name, a psychology and a tier, pays SOL to the treasury,
// and the agent exists: it joins the operator's swarm (hosted, the cheapest tier), and on the
// code tier its owner can also download everything needed to run it themselves. Owners can
// link an X account to their agent on either tier.
//
// The owner is whoever holds the owner token handed out with the order. The paying wallet is
// recorded but never asked to sign anything else.
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

import { getBase58Decoder } from "@solana/kit";

import type { RosterEntry } from "../roster";
import { PSYCHOLOGIES, type PsychologyId } from "../types";

import { tierPriceLamports, TIERS, type MintConfig, type Tier } from "./config";
import { findByReference, lamportsToSol, payUrl, verifyPayment, type Rpc } from "./pay";
import type { MintedAgent, MintStore, Order } from "./store";
import { authorizeUrl, exchangeCode, newVerifier, refreshTokens, seal, unseal, xMe, xPost, xRevoke, type XApp, type XTokens } from "./x";

export class MintError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export interface MintDeps {
  cfg: MintConfig;
  store: MintStore;
  rpc: Rpc;
  now?: () => number;
  fetcher?: typeof fetch;
  env?: Record<string, string | undefined>;
  /** Names already taken by the built-in roster. */
  reservedNames?: string[];
}

export interface OrderRequest {
  name: string;
  preset: string;
  persona?: string;
  tier: string;
  github?: string;
}

const NAME = /^[A-Za-z0-9_]{3,20}$/;
const GITHUB_USER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const PERSONA_MAX = 600;
/** How often one order may trigger an on-chain lookup when its status is polled. */
const LOOKUP_EVERY_MS = 3_000;

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const sameHash = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const cleanPersona = (s: unknown) => (typeof s === "string" ? s.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim().slice(0, PERSONA_MAX) : "");

/** The persona the owner wrote, or the preset's own line when they left it blank. */
function personaOf(a: Pick<MintedAgent, "name" | "preset" | "persona">): string {
  if (a.persona) return a.persona;
  const p = PSYCHOLOGIES.find((x) => x.id === a.preset);
  return p ? `${p.name}: ${p.summary}` : a.name;
}

export class MintService {
  readonly cfg: MintConfig;
  private store: MintStore;
  private rpc: Rpc;
  private now: () => number;
  private fetcher: typeof fetch;
  private env: Record<string, string | undefined>;
  private reserved: Set<string>;
  private lastLookup = new Map<string, number>();

  constructor(deps: MintDeps) {
    this.cfg = deps.cfg;
    this.store = deps.store;
    this.rpc = deps.rpc;
    this.now = deps.now ?? Date.now;
    this.fetcher = deps.fetcher ?? fetch;
    this.env = deps.env ?? process.env;
    this.reserved = new Set((deps.reservedNames ?? []).map((n) => n.toLowerCase()));
  }

  /** Why X linking is unavailable, or null when it is ready. */
  xUnavailable(): string | null {
    const x = this.cfg.x;
    if (!x.enabled) return "X linking is turned off";
    if (!this.env[x.clientIdEnv]) return `X linking needs ${x.clientIdEnv}`;
    if (!this.env[x.secretEnv]) return `X linking needs ${x.secretEnv}`;
    return null;
  }

  private xApp(): XApp {
    const why = this.xUnavailable();
    if (why) throw new MintError(503, why);
    const x = this.cfg.x;
    return { clientId: this.env[x.clientIdEnv]!, clientSecret: this.env[x.clientSecretEnv] || undefined, redirectUri: `${this.cfg.publicUrl}/x/callback` };
  }

  /** What the mint page needs: prices, presets, how many are left. */
  info() {
    const minted = this.store.agents().length;
    return {
      treasury: this.cfg.treasury,
      tiers: TIERS.map((t) => ({
        id: t,
        priceSol: this.cfg.tiers[t].priceSol,
        includes: t === "hosted" ? ["Runs on our swarm", "Link an X account"] : ["Everything in hosted", "The agent's code and config to run it yourself", ...(this.cfg.tiers.code.repo ? ["Read access to the repository"] : [])],
      })),
      presets: PSYCHOLOGIES.map((p) => ({ id: p.id, name: p.name, summary: p.summary })),
      minted,
      maxSupply: this.cfg.maxSupply,
      orderTtlMin: this.cfg.orderTtlMin,
      x: this.xUnavailable() === null,
      repo: this.cfg.tiers.code.repo !== null,
    };
  }

  private nameTaken(id: string, exceptOrder?: string): boolean {
    if (this.reserved.has(id) || this.store.agent(id)) return true;
    return this.store.orders().some((o) => o.kind === "mint" && o.status === "pending" && o.agentId === id && o.id !== exceptOrder);
  }

  private newOrder(o: Pick<Order, "kind" | "tier" | "agentId" | "name" | "preset" | "persona" | "github" | "ownerTokenHash">, price: bigint): Order {
    const now = this.now();
    const open = new Set(this.store.orders().filter((x) => x.status === "pending").map((x) => x.lamports));
    let lamports = "";
    for (let i = 0; i < 50 && (!lamports || open.has(lamports)); i++) lamports = (price + BigInt(randomInt(1, 10_000))).toString();
    if (open.has(lamports)) throw new MintError(503, "too many open orders, try again in a minute");
    const order: Order = {
      ...o,
      id: randomBytes(12).toString("hex"),
      status: "pending",
      lamports,
      reference: getBase58Decoder().decode(randomBytes(32)),
      createdAt: now,
      expiresAt: now + this.cfg.orderTtlMin * 60_000,
    };
    this.store.putOrder(order);
    return order;
  }

  /** Opens an order to mint a new agent. The owner token is shown once, here. */
  createOrder(req: OrderRequest): { order: ReturnType<MintService["publicOrder"]>; ownerToken: string } {
    this.store.sweep(this.now());
    const name = typeof req.name === "string" ? req.name.trim() : "";
    if (!NAME.test(name)) throw new MintError(400, "name must be 3 to 20 letters, digits or underscores");
    if (!TIERS.includes(req.tier as Tier)) throw new MintError(400, `tier must be one of ${TIERS.join(", ")}`);
    if (!PSYCHOLOGIES.some((p) => p.id === req.preset)) throw new MintError(400, `preset must be one of ${PSYCHOLOGIES.map((p) => p.id).join(", ")}`);
    const github = req.github ? String(req.github).trim().replace(/^@/, "") : undefined;
    if (github && !GITHUB_USER.test(github)) throw new MintError(400, "github must be a GitHub username");
    const id = name.toLowerCase();
    if (this.nameTaken(id)) throw new MintError(409, `the name "${name}" is taken`);
    if (this.cfg.maxSupply != null) {
      const claimed = this.store.agents().length + this.store.orders().filter((o) => o.kind === "mint" && o.status === "pending").length;
      if (claimed >= this.cfg.maxSupply) throw new MintError(409, "every agent has been minted");
    }
    const ownerToken = randomBytes(32).toString("base64url");
    const tier = req.tier as Tier;
    const order = this.newOrder({ kind: "mint", tier, agentId: id, name, preset: req.preset, persona: cleanPersona(req.persona), github, ownerTokenHash: sha(ownerToken) }, tierPriceLamports(this.cfg, tier));
    return { order: this.publicOrder(order), ownerToken };
  }

  /** Opens an order to move a hosted agent to the code tier for the price difference. */
  createUpgrade(agentId: string, ownerToken: string, github?: string) {
    this.store.sweep(this.now());
    const agent = this.owned(agentId, ownerToken);
    if (agent.tier === "code") throw new MintError(409, "this agent already has the code tier");
    const gh = github ? String(github).trim().replace(/^@/, "") : agent.github;
    if (gh && !GITHUB_USER.test(gh)) throw new MintError(400, "github must be a GitHub username");
    const price = tierPriceLamports(this.cfg, "code") - tierPriceLamports(this.cfg, "hosted");
    const order = this.newOrder({ kind: "upgrade", tier: "code", agentId: agent.id, name: agent.name, preset: agent.preset, persona: agent.persona, github: gh, ownerTokenHash: agent.ownerTokenHash }, price);
    return this.publicOrder(order);
  }

  publicOrder(o: Order) {
    const lamports = BigInt(o.lamports);
    return {
      id: o.id,
      kind: o.kind,
      status: o.status,
      tier: o.tier,
      agentId: o.agentId,
      name: o.name,
      treasury: this.cfg.treasury,
      lamports: o.lamports,
      amountSol: lamportsToSol(lamports),
      reference: o.reference,
      payUrl: payUrl(this.cfg.treasury, lamports, o.reference, "Agent mint", `${o.kind === "mint" ? "Mint" : "Upgrade"} ${o.name} (${o.tier})`),
      expiresAt: o.expiresAt,
      signature: o.signature,
    };
  }

  /** An order's status. While it is unpaid, this also looks on chain for a payment carrying its reference. */
  async orderStatus(id: string) {
    this.store.sweep(this.now());
    let o = this.store.order(id);
    if (!o) throw new MintError(404, "no such order");
    const last = this.lastLookup.get(id) ?? 0;
    if (o.status === "pending" && this.now() - last >= LOOKUP_EVERY_MS) {
      this.lastLookup.set(id, this.now());
      const sigs = await findByReference(this.rpc, o.reference).catch(() => []);
      for (const sig of sigs) {
        if (this.store.signatureUsed(sig)) continue;
        try {
          await this.settle(o, sig);
          break;
        } catch {
          // Not a valid payment for this order; keep looking.
        }
      }
      o = this.store.order(id)!;
    }
    return this.publicOrder(o);
  }

  /** Settles an order with a transaction signature the payer pasted in. */
  async confirm(id: string, signature: string) {
    this.store.sweep(this.now());
    const o = this.store.order(id);
    if (!o) throw new MintError(404, "no such order");
    if (typeof signature !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(signature)) throw new MintError(400, "signature must be a Solana transaction signature");
    await this.settle(o, signature);
    return this.publicOrder(this.store.order(id)!);
  }

  private async settle(o: Order, signature: string): Promise<void> {
    if (o.status === "paid") {
      if (o.signature === signature) return;
      throw new MintError(409, "this order is already paid");
    }
    if (this.store.signatureUsed(signature)) throw new MintError(409, "this transaction already paid for another order");
    const res = await verifyPayment(this.rpc, { signature, treasury: this.cfg.treasury, lamports: BigInt(o.lamports), reference: o.reference, notBefore: o.createdAt });
    if (!res.ok) throw new MintError(res.retry ? 202 : 400, res.reason);
    // The chain lookup took time: check again that nothing settled meanwhile.
    const fresh = this.store.order(o.id)!;
    if (fresh.status === "paid") {
      if (fresh.signature === signature) return;
      throw new MintError(409, "this order is already paid");
    }
    if (this.store.signatureUsed(signature)) throw new MintError(409, "this transaction already paid for another order");
    const now = this.now();
    let agent: MintedAgent;
    if (fresh.kind === "mint") {
      // A payment that lands after the order expired still mints, unless the name went to someone else meanwhile.
      if (this.nameTaken(fresh.agentId, fresh.id)) throw new MintError(409, `payment received, but the name "${fresh.name}" was taken after this order expired. Contact the operator with your transaction signature.`);
      agent = {
        id: fresh.agentId,
        name: fresh.name,
        preset: fresh.preset,
        persona: fresh.persona,
        tier: fresh.tier,
        owner: res.payer,
        ownerTokenHash: fresh.ownerTokenHash,
        mintedAt: now,
        signatures: [signature],
        paidLamports: res.receivedLamports.toString(),
        github: fresh.github,
      };
    } else {
      const cur = this.store.agent(fresh.agentId);
      if (!cur) throw new MintError(404, "the agent this order upgrades no longer exists");
      agent = { ...cur, tier: "code", github: fresh.github ?? cur.github, signatures: [...cur.signatures, signature], paidLamports: (BigInt(cur.paidLamports) + res.receivedLamports).toString() };
    }
    this.store.settle({ ...fresh, status: "paid", signature, payer: res.payer, paidAt: now }, agent, signature);
    if (agent.tier === "code" && agent.github) await this.inviteToRepo(agent.id);
  }

  private owned(agentId: string, ownerToken: string | undefined): MintedAgent {
    const a = this.store.agent(agentId);
    if (!a) throw new MintError(404, "no such agent");
    if (!ownerToken || !sameHash(sha(ownerToken), a.ownerTokenHash)) throw new MintError(403, "wrong owner token for this agent");
    return a;
  }

  publicAgent(a: MintedAgent) {
    return { id: a.id, name: a.name, preset: a.preset, tier: a.tier, owner: a.owner, mintedAt: a.mintedAt, x: a.x ? { handle: a.x.handle, linkedAt: a.x.linkedAt } : null };
  }

  listAgents() {
    return this.store.agents().map((a) => this.publicAgent(a));
  }

  /** The owner's view: the public fields plus persona, payments and repository access. */
  ownerView(agentId: string, ownerToken: string | undefined) {
    const a = this.owned(agentId, ownerToken);
    return { ...this.publicAgent(a), persona: a.persona, signatures: a.signatures, paidSol: lamportsToSol(BigInt(a.paidLamports)), github: a.github ?? null, githubInvite: a.githubInvite ?? null };
  }

  /** The roster entry a minted agent is deployed from. */
  rosterEntry(a: MintedAgent): RosterEntry {
    return { name: a.name, preset: a.preset as PsychologyId, persona: personaOf(a) };
  }

  /** Code tier: the agent's definition and a ready config to run it with this repository's code. */
  codeBundle(agentId: string, ownerToken: string | undefined) {
    const a = this.owned(agentId, ownerToken);
    if (a.tier !== "code") throw new MintError(402, "the code is part of the code tier; upgrade this agent to download it");
    const p = PSYCHOLOGIES.find((x) => x.id === a.preset);
    const entry = { name: a.name, preset: a.preset, persona: personaOf(a), ...(p ? { traits: p.traits } : {}) };
    const g = this.cfg.agent;
    return {
      agent: entry,
      swarm: {
        mode: "paper",
        tickMs: 15_000,
        feed: { kind: "jupiter" },
        groups: [{ roster: [a.name], bankrollSol: g.bankrollSol, targets: g.targets, tasks: g.tasks.filter((t) => t !== "xpost"), brain: g.brain, rules: g.rules }],
      },
      repository: this.cfg.tiers.code.repo ? `https://github.com/${this.cfg.tiers.code.repo}` : null,
      githubInvite: a.githubInvite ?? null,
      howToRun: [
        "Clone the repository and run `pnpm install`.",
        "Append `agent` to the array in data/sim-agents.json.",
        "Save `swarm` as swarm.json, then `pnpm start -- --config swarm.json`.",
        "It runs on paper until you set mode to live and SWARM_LIVE=1. See the README before going live.",
      ],
    };
  }

  /** Sets the owner's GitHub username and (re)sends the repository invite. */
  async setGithub(agentId: string, ownerToken: string | undefined, username: string) {
    const a = this.owned(agentId, ownerToken);
    if (a.tier !== "code") throw new MintError(402, "repository access is part of the code tier");
    const gh = String(username ?? "").trim().replace(/^@/, "");
    if (!GITHUB_USER.test(gh)) throw new MintError(400, "github must be a GitHub username");
    this.store.putAgent({ ...a, github: gh });
    await this.inviteToRepo(a.id);
    return this.ownerView(agentId, ownerToken);
  }

  /** Invites a code-tier owner to the repository with read access. Never throws: the result is recorded on the agent. */
  private async inviteToRepo(agentId: string): Promise<void> {
    const a = this.store.agent(agentId);
    if (!a?.github) return;
    const { repo, githubTokenEnv } = this.cfg.tiers.code;
    const token = this.env[githubTokenEnv];
    const at = this.now();
    if (!repo || !token) return this.store.putAgent({ ...a, githubInvite: { status: "skipped", detail: !repo ? "no repository configured" : `${githubTokenEnv} is not set`, at } });
    try {
      const res = await this.fetcher(`https://api.github.com/repos/${repo}/collaborators/${a.github}`, {
        method: "PUT",
        headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "content-type": "application/json", "user-agent": "agent-mint" },
        body: JSON.stringify({ permission: "pull" }),
      });
      // 201: invite sent. 204: already a collaborator.
      const ok = res.status === 201 || res.status === 204;
      this.store.putAgent({ ...this.store.agent(agentId)!, githubInvite: ok ? { status: "invited", at } : { status: "failed", detail: `GitHub answered ${res.status}`, at } });
    } catch (e) {
      this.store.putAgent({ ...this.store.agent(agentId)!, githubInvite: { status: "failed", detail: (e as Error).message.slice(0, 120), at } });
    }
  }

  /** Starts linking an X account: returns the X page the owner approves on. */
  xStart(agentId: string, ownerToken: string | undefined): { url: string } {
    const a = this.owned(agentId, ownerToken);
    const app = this.xApp();
    this.store.sweep(this.now());
    const state = randomBytes(24).toString("base64url");
    const verifier = newVerifier();
    this.store.putXState(state, { agentId: a.id, verifier, createdAt: this.now() });
    return { url: authorizeUrl(app, state, verifier) };
  }

  /** X sent the owner back with a code: trade it for tokens and record whose account it is. */
  async xFinish(state: string, code: string) {
    const app = this.xApp();
    this.store.sweep(this.now());
    const pending = typeof state === "string" ? this.store.takeXState(state) : undefined;
    if (!pending) throw new MintError(400, "this X link has expired; start again from your agent");
    const a = this.store.agent(pending.agentId);
    if (!a) throw new MintError(404, "no such agent");
    if (typeof code !== "string" || !code) throw new MintError(400, "X did not return a code");
    const tokens = await exchangeCode(app, code, pending.verifier, this.fetcher, this.now());
    const me = await xMe(tokens.accessToken, this.fetcher);
    // One X account can back several agents only when the same wallet minted them.
    const other = this.store.agents().find((o) => o.id !== a.id && o.x?.userId === me.id && o.owner !== a.owner);
    if (other) throw new MintError(409, `@${me.handle} is already linked to another owner's agent`);
    const cur = this.store.agent(a.id)!;
    this.store.putAgent({ ...cur, x: { userId: me.id, handle: me.handle, linkedAt: this.now(), tokens: seal(this.env[this.cfg.x.secretEnv]!, tokens) } });
    return this.publicAgent(this.store.agent(a.id)!);
  }

  async xUnlink(agentId: string, ownerToken: string | undefined) {
    const a = this.owned(agentId, ownerToken);
    if (!a.x) return this.publicAgent(a);
    if (this.xUnavailable() === null) {
      try {
        const t = unseal<XTokens>(this.env[this.cfg.x.secretEnv]!, a.x.tokens);
        await xRevoke(this.xApp(), t.refreshToken ?? t.accessToken, this.fetcher);
      } catch {
        // Unlinking still goes ahead if the stored tokens can't be read or revoked.
      }
    }
    const { x: _x, ...rest } = a;
    this.store.putAgent(rest);
    return this.publicAgent(rest);
  }

  /** Posts as the agent's linked X account, refreshing its token first when it is about to run out. */
  async xPostAs(agentId: string, text: string): Promise<string> {
    const a = this.store.agent(agentId);
    if (!a?.x) throw new MintError(409, "this agent has no X account linked");
    const app = this.xApp();
    const secret = this.env[this.cfg.x.secretEnv]!;
    let t = unseal<XTokens>(secret, a.x.tokens);
    if (t.expiresAt - this.now() < 60_000) {
      if (!t.refreshToken) throw new MintError(409, "the X link has expired; link the account again");
      const next = await refreshTokens(app, t.refreshToken, this.fetcher, this.now());
      t = { ...next, refreshToken: next.refreshToken ?? t.refreshToken };
      this.store.putAgent({ ...this.store.agent(agentId)!, x: { ...a.x, tokens: seal(secret, t) } });
    }
    return xPost(t.accessToken, text, this.fetcher);
  }
}
