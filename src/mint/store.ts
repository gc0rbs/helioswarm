// The mint's records: open and settled orders, minted agents, payment signatures already
// used, and X links in progress. One JSON file, rewritten atomically on every change. The mint
// server and a swarm run can both have it open, so every call first picks up what the other wrote.
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Tier } from "./config";

export type OrderKind = "mint" | "upgrade";
export type OrderStatus = "pending" | "paid" | "expired";

export interface Order {
  id: string;
  kind: OrderKind;
  status: OrderStatus;
  tier: Tier;
  /** Lower-case agent id this order mints or upgrades. */
  agentId: string;
  name: string;
  preset: string;
  persona: string;
  github?: string;
  /** Exact amount to pay, as a decimal string of lamports. A few lamports of dust make it unique among open orders. */
  lamports: string;
  /** Solana Pay reference: a throwaway address added to the payment so it can be found on chain. */
  reference: string;
  ownerTokenHash: string;
  createdAt: number;
  expiresAt: number;
  signature?: string;
  payer?: string;
  paidAt?: number;
}

export interface XLink {
  userId: string;
  handle: string;
  linkedAt: number;
  /** Encrypted { accessToken, refreshToken, expiresAt }. */
  tokens: string;
}

export interface MintedAgent {
  id: string;
  name: string;
  preset: string;
  persona: string;
  tier: Tier;
  /** Wallet that paid for the mint. */
  owner: string;
  ownerTokenHash: string;
  mintedAt: number;
  /** Payment signatures: the mint, then any upgrade. */
  signatures: string[];
  paidLamports: string;
  github?: string;
  githubInvite?: { status: "invited" | "failed" | "skipped"; detail?: string; at: number };
  x?: XLink;
}

export interface PendingXLink {
  agentId: string;
  verifier: string;
  createdAt: number;
}

interface State {
  orders: Record<string, Order>;
  agents: Record<string, MintedAgent>;
  usedSignatures: string[];
  xStates: Record<string, PendingXLink>;
}

const empty = (): State => ({ orders: {}, agents: {}, usedSignatures: [], xStates: {} });

export class MintStore {
  private state: State = empty();
  private file: string | null;
  private mtime = 0;

  /** Pass null to keep everything in memory (tests). */
  constructor(dir: string | null) {
    this.file = dir ? join(dir, "mint.json") : null;
    if (dir) mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.sync();
  }

  /** Reloads the file when another process has rewritten it. */
  private sync(): State {
    if (!this.file || !existsSync(this.file)) return this.state;
    const m = statSync(this.file).mtimeMs;
    if (m !== this.mtime) {
      this.state = { ...empty(), ...(JSON.parse(readFileSync(this.file, "utf8")) as State) };
      this.mtime = m;
    }
    return this.state;
  }

  private save() {
    if (!this.file) return;
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 1), { mode: 0o600 });
    renameSync(tmp, this.file);
    this.mtime = statSync(this.file).mtimeMs;
  }

  order = (id: string): Order | undefined => this.sync().orders[id];
  orders = (): Order[] => Object.values(this.sync().orders);
  agent = (id: string): MintedAgent | undefined => this.sync().agents[id.toLowerCase()];
  agents = (): MintedAgent[] => Object.values(this.sync().agents).sort((a, b) => a.mintedAt - b.mintedAt);
  signatureUsed = (sig: string): boolean => this.sync().usedSignatures.includes(sig);

  putOrder(o: Order) {
    this.sync();
    this.state.orders[o.id] = o;
    this.save();
  }

  /** Settles an order and writes its agent in one save, so a crash can't leave a paid order without its agent. */
  settle(o: Order, agent: MintedAgent, signature: string) {
    this.sync();
    this.state.orders[o.id] = o;
    this.state.agents[agent.id] = agent;
    this.state.usedSignatures.push(signature);
    this.save();
  }

  putAgent(a: MintedAgent) {
    this.sync();
    this.state.agents[a.id] = a;
    this.save();
  }

  putXState(state: string, p: PendingXLink) {
    this.sync();
    this.state.xStates[state] = p;
    this.save();
  }

  takeXState(state: string): PendingXLink | undefined {
    const p = this.sync().xStates[state];
    if (p) {
      delete this.state.xStates[state];
      this.save();
    }
    return p;
  }

  /** Marks overdue orders expired and drops stale X link attempts. */
  sweep(now: number, xTtlMs = 10 * 60_000) {
    let changed = false;
    this.sync();
    for (const o of Object.values(this.state.orders)) {
      if (o.status === "pending" && o.expiresAt <= now) {
        o.status = "expired";
        changed = true;
      }
    }
    for (const [k, p] of Object.entries(this.state.xStates)) {
      if (p.createdAt + xTtlMs <= now) {
        delete this.state.xStates[k];
        changed = true;
      }
    }
    if (changed) this.save();
  }
}
