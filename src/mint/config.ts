// The "mint" section of the swarm config: what it costs to mint an agent, where the SOL goes,
// and what a minted agent is deployed with. Secrets (X client secret, GitHub token, the key
// that encrypts X tokens) are read from the environment, never from the file.
import { readFileSync } from "node:fs";

import { isMint, type BrainKind, type Target } from "../config";
import { normalizeRules, type TradingRules } from "../types";

export const LAMPORTS_PER_SOL = 1_000_000_000;

/** hosted: the agent runs on the operator's swarm. code: hosted, plus the agent's code and config to run it yourself. */
export type Tier = "hosted" | "code";
export const TIERS: Tier[] = ["hosted", "code"];

export interface MintConfig {
  /** Address that receives mint payments. Public; its key is never needed here. */
  treasury: string;
  /** Folder for the mint store (orders, minted agents), relative to the config file. */
  dataDir: string;
  port: number;
  /** Public base URL of the mint server, used for the X callback. */
  publicUrl: string;
  /** Behind a reverse proxy: take the client address from X-Forwarded-For when limiting order creation. */
  trustProxy: boolean;
  /** Most agents that can ever be minted; null for no cap. */
  maxSupply: number | null;
  /** Minutes an unpaid order stays open. */
  orderTtlMin: number;
  tiers: {
    hosted: { priceSol: number };
    code: {
      priceSol: number;
      /** owner/name of the GitHub repository code-tier owners get read access to (optional). */
      repo: string | null;
      /** Env var holding a GitHub token that can invite collaborators to `repo`. */
      githubTokenEnv: string;
    };
  };
  /** What every minted agent is deployed with. */
  agent: {
    bankrollSol: number;
    targets: Target[];
    tasks: string[];
    brain: BrainKind;
    rules: TradingRules;
  };
  x: {
    enabled: boolean;
    clientIdEnv: string;
    clientSecretEnv: string;
    /** Env var holding the secret that encrypts stored X tokens. */
    secretEnv: string;
    /** Let agents with a linked X account post their own reports (the "xpost" task). */
    post: boolean;
    /** Ticks between posts when `post` is on. */
    postEveryTicks: number;
  };
}

const num = (x: unknown, label: string, min: number, max: number, dflt?: number): number => {
  if (x === undefined && dflt !== undefined) return dflt;
  if (typeof x !== "number" || !Number.isFinite(x) || x < min || x > max) throw new Error(`${label} must be a number between ${min} and ${max}`);
  return x;
};

export const solToLamports = (sol: number): bigint => BigInt(Math.round(sol * LAMPORTS_PER_SOL));

export function parseMintConfig(raw: unknown): MintConfig {
  if (!raw || typeof raw !== "object") throw new Error("mint must be an object");
  const r = raw as Record<string, any>;
  if (typeof r.treasury !== "string" || !isMint(r.treasury)) throw new Error("mint.treasury must be a Solana address");
  // SOL sent to a program address can't be recovered.
  if (/^1+$/.test(r.treasury)) throw new Error("mint.treasury is the System Program address; set it to a wallet you control");
  const hosted = num(r.tiers?.hosted?.priceSol, "mint.tiers.hosted.priceSol", 0.000_01, 100_000, 0.05);
  const code = num(r.tiers?.code?.priceSol, "mint.tiers.code.priceSol", 0.000_01, 100_000, 0.5);
  // Minting on the operator's system is the cheapest way in; the code costs extra.
  if (code <= hosted) throw new Error("mint.tiers.code.priceSol must be higher than mint.tiers.hosted.priceSol: hosted is the cheapest tier");
  const repo = r.tiers?.code?.repo ?? null;
  if (repo !== null && (typeof repo !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo))) throw new Error('mint.tiers.code.repo must look like "owner/name"');
  const a = r.agent ?? {};
  const targets: Target[] = (Array.isArray(a.targets) ? a.targets : []).map((t: any, i: number) => {
    const mint = typeof t === "string" ? t : t?.mint;
    if (typeof mint !== "string" || !isMint(mint)) throw new Error(`mint.agent.targets[${i}].mint is not a Solana address`);
    return { mint, symbol: typeof t === "object" && t.symbol ? String(t.symbol) : mint.slice(0, 4) };
  });
  if (!targets.length) throw new Error("mint.agent.targets must list at least one mint");
  const port = num(r.port, "mint.port", 1, 65_535, 4600);
  return {
    treasury: r.treasury,
    dataDir: typeof r.dataDir === "string" && r.dataDir ? r.dataDir : "mint-data",
    port,
    publicUrl: String(r.publicUrl ?? `http://localhost:${port}`).replace(/\/+$/, ""),
    trustProxy: r.trustProxy === true,
    maxSupply: r.maxSupply == null ? null : num(r.maxSupply, "mint.maxSupply", 1, 10_000_000),
    orderTtlMin: num(r.orderTtlMin, "mint.orderTtlMin", 1, 1_440, 15),
    tiers: { hosted: { priceSol: hosted }, code: { priceSol: code, repo, githubTokenEnv: r.tiers?.code?.githubTokenEnv ?? "MINT_GITHUB_TOKEN" } },
    agent: {
      bankrollSol: num(a.bankrollSol, "mint.agent.bankrollSol", 0.0001, 100_000, 0.1),
      targets,
      tasks: Array.isArray(a.tasks) && a.tasks.length ? a.tasks.map(String) : ["trade", "report"],
      brain: a.brain === "claude" ? "claude" : "traits",
      rules: normalizeRules(a.rules),
    },
    x: {
      enabled: r.x?.enabled !== false,
      clientIdEnv: r.x?.clientIdEnv ?? "X_CLIENT_ID",
      clientSecretEnv: r.x?.clientSecretEnv ?? "X_CLIENT_SECRET",
      secretEnv: r.x?.secretEnv ?? "MINT_SECRET",
      post: r.x?.post === true,
      postEveryTicks: num(r.x?.postEveryTicks, "mint.x.postEveryTicks", 1, 1_000_000, 240),
    },
  };
}

/** The config file's "mint" section, or null when it has none. */
export function loadMintConfig(path: string): MintConfig | null {
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  return raw.mint == null ? null : parseMintConfig(raw.mint);
}

export const tierPriceLamports = (cfg: MintConfig, tier: Tier): bigint => solToLamports(cfg.tiers[tier].priceSol);
