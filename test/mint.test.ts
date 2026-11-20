import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  challengeOf,
  expandWithMinted,
  mintHandler,
  MintError,
  MintService,
  MintStore,
  parseConfig,
  parseMintConfig,
  payUrl,
  reportText,
  seal,
  unseal,
  verifyPayment,
  type MintConfig,
  type Rpc,
} from "../src";

const TREASURY = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const PAYER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const sig = (n: number) => `${n}`.padStart(2, "2").repeat(44).slice(0, 88);

const mintCfg = (over: Record<string, unknown> = {}): MintConfig =>
  parseMintConfig({ treasury: TREASURY, agent: { targets: [{ mint: BONK, symbol: "BONK" }] }, tiers: { code: { repo: "acme/swarm" } }, ...over });

interface ChainTx {
  keys: string[];
  /** Lamports the treasury gained. */
  received: bigint;
  blockTime?: number;
  err?: unknown;
}

/** A stand-in chain: transactions by signature, found by any key they carry. */
function chain() {
  const txs = new Map<string, ChainTx>();
  const rpc: Rpc = async (method, params) => {
    if (method === "getTransaction") {
      const t = txs.get(params[0] as string);
      if (!t) return null;
      const i = t.keys.indexOf(TREASURY);
      const pre = t.keys.map(() => 1_000_000_000);
      const post = pre.map((p, k) => (k === i ? p + Number(t.received) : p));
      return { blockTime: t.blockTime ?? 2_000_000, meta: { err: t.err ?? null, preBalances: pre, postBalances: post }, transaction: { message: { accountKeys: t.keys } } };
    }
    if (method === "getSignaturesForAddress") return [...txs].filter(([, t]) => t.keys.includes(params[0] as string)).map(([signature, t]) => ({ signature, err: t.err ?? null }));
    throw new Error(`unexpected rpc ${method}`);
  };
  return { txs, rpc };
}

function setup(over: Record<string, unknown> = {}, env: Record<string, string> = {}, fetcher?: typeof fetch) {
  const c = chain();
  let now = 1_000_000_000_000;
  const store = new MintStore(null);
  const svc = new MintService({ cfg: mintCfg(over), store, rpc: c.rpc, now: () => now, env, fetcher, reservedNames: ["bagz4days_"] });
  /** Pays an order the way a Solana Pay wallet would: exact amount, reference attached. */
  const pay = (o: { lamports: string; reference: string }, n: number, t: Partial<ChainTx> = {}) => {
    c.txs.set(sig(n), { keys: [PAYER, TREASURY, o.reference], received: BigInt(o.lamports), blockTime: now / 1000, ...t });
    return sig(n);
  };
  return { ...c, store, svc, pay, tick: (ms: number) => (now += ms), now: () => now };
}

describe("mint config", () => {
  it("defaults to a cheap hosted tier and a pricier code tier", () => {
    const c = mintCfg();
    expect(c.tiers.hosted.priceSol).toBe(0.05);
    expect(c.tiers.code.priceSol).toBe(0.5);
    expect(c.publicUrl).toBe("http://localhost:4600");
  });

  it("refuses a code tier that is not more expensive than hosted", () => {
    expect(() => mintCfg({ tiers: { hosted: { priceSol: 1 }, code: { priceSol: 1 } } })).toThrow(/hosted is the cheapest tier/);
  });

  it("refuses a missing or unspendable treasury", () => {
    expect(() => parseMintConfig({ agent: { targets: [BONK] } })).toThrow(/treasury/);
    expect(() => mintCfg({ treasury: "11111111111111111111111111111111" })).toThrow(/System Program/);
  });
});

describe("payment check", () => {
  const base = { signature: sig(1), treasury: TREASURY, lamports: 50_001_234n, reference: "Ref1111111111111111111111111111111111111111", notBefore: 2_000_000_000 };

  it("accepts the exact amount without a reference, and names the payer", async () => {
    const { txs, rpc } = chain();
    txs.set(sig(1), { keys: [PAYER, TREASURY], received: 50_001_234n });
    expect(await verifyPayment(rpc, base)).toEqual({ ok: true, payer: PAYER, receivedLamports: 50_001_234n });
  });

  it("refuses a different amount unless the reference is attached", async () => {
    const { txs, rpc } = chain();
    txs.set(sig(1), { keys: [PAYER, TREASURY], received: 60_000_000n });
    expect((await verifyPayment(rpc, base)).ok).toBe(false);
    txs.set(sig(1), { keys: [PAYER, TREASURY, base.reference], received: 60_000_000n });
    expect((await verifyPayment(rpc, base)).ok).toBe(true);
    txs.set(sig(1), { keys: [PAYER, TREASURY, base.reference], received: 40_000_000n });
    expect((await verifyPayment(rpc, base)).ok).toBe(false);
  });

  it("refuses failed, unrelated and stale transactions, and asks to retry unknown ones", async () => {
    const { txs, rpc } = chain();
    expect(await verifyPayment(rpc, base)).toMatchObject({ ok: false, retry: true });
    txs.set(sig(1), { keys: [PAYER, TREASURY], received: 50_001_234n, err: { InstructionError: [0, "Custom"] } });
    expect(await verifyPayment(rpc, base)).toMatchObject({ ok: false, reason: "transaction failed on chain" });
    txs.set(sig(1), { keys: [PAYER, PAYER], received: 0n });
    expect(await verifyPayment(rpc, base)).toMatchObject({ ok: false, reason: "transaction does not pay the treasury" });
    txs.set(sig(1), { keys: [PAYER, TREASURY], received: 50_001_234n, blockTime: 1_000_000 });
    expect(await verifyPayment(rpc, base)).toMatchObject({ ok: false, reason: "transaction is older than the order" });
  });

  it("builds a Solana Pay link with the exact amount", () => {
    expect(payUrl(TREASURY, 50_001_234n, "Ref", "Agent mint", "Mint kev")).toBe(`solana:${TREASURY}?amount=0.050001234&reference=Ref&label=Agent+mint&message=Mint+kev`);
  });
});

describe("minting", () => {
  it("mints a hosted agent when the payment with its reference lands", async () => {
    const s = setup();
    const { order, ownerToken } = s.svc.createOrder({ name: "Sol_Kev", preset: "sniper", persona: "Buys early.", tier: "hosted" });
    // Hosted price plus under 10,000 lamports of dust that identify the order.
    expect(BigInt(order.lamports) / 10_000n).toBe(5_000n);
    expect((await s.svc.orderStatus(order.id)).status).toBe("pending");
    s.pay(order, 1);
    expect((await s.svc.orderStatus(order.id)).status).toBe("pending"); // chain lookups are spaced out
    s.tick(3_000);
    expect(await s.svc.orderStatus(order.id)).toMatchObject({ status: "paid", agentId: "sol_kev", signature: sig(1) });
    expect(s.svc.listAgents()).toEqual([expect.objectContaining({ id: "sol_kev", name: "Sol_Kev", preset: "sniper", tier: "hosted", owner: PAYER, x: null })]);
    expect(s.svc.ownerView("sol_kev", ownerToken)).toMatchObject({ persona: "Buys early.", signatures: [sig(1)], paidSol: `0.0${order.lamports}`.replace(/0+$/, "") });
  });

  it("settles a hand-typed transfer by pasted signature, once", async () => {
    const { svc, txs } = setup();
    const a = svc.createOrder({ name: "alpha", preset: "holder", tier: "hosted" });
    const b = svc.createOrder({ name: "beta", preset: "holder", tier: "hosted" });
    expect(a.order.lamports).not.toBe(b.order.lamports);
    txs.set(sig(3), { keys: [PAYER, TREASURY], received: BigInt(a.order.lamports), blockTime: 1_000_000_000 });
    // The amount belongs to order a, so b can't claim it.
    await expect(svc.confirm(b.order.id, sig(3))).rejects.toMatchObject({ status: 400 });
    expect((await svc.confirm(a.order.id, sig(3))).status).toBe("paid");
    expect((await svc.confirm(a.order.id, sig(3))).status).toBe("paid"); // same signature again is harmless
    txs.set(sig(4), { keys: [PAYER, TREASURY], received: BigInt(a.order.lamports), blockTime: 1_000_000_000 });
    await expect(svc.confirm(a.order.id, sig(4))).rejects.toMatchObject({ status: 409 });
    await expect(svc.confirm(b.order.id, "nope")).rejects.toMatchObject({ status: 400 });
    await expect(svc.confirm(b.order.id, sig(9))).rejects.toMatchObject({ status: 202 });
    expect(svc.listAgents().map((x) => x.id)).toEqual(["alpha"]);
  });

  it("refuses bad names, presets and tiers, taken names and a full supply", () => {
    const { svc } = setup({ maxSupply: 2 });
    const ok = { name: "alpha", preset: "degen", tier: "hosted" };
    expect(() => svc.createOrder({ ...ok, name: "a b" })).toThrow(/name must be/);
    expect(() => svc.createOrder({ ...ok, preset: "wizard" })).toThrow(/preset must be/);
    expect(() => svc.createOrder({ ...ok, tier: "free" })).toThrow(/tier must be/);
    expect(() => svc.createOrder({ ...ok, name: "BAGZ4DAYS_" })).toThrow(/taken/);
    expect(() => svc.createOrder({ ...ok, tier: "code", github: "not a user" })).toThrow(/GitHub username/);
    svc.createOrder(ok);
    expect(() => svc.createOrder({ ...ok, name: "ALPHA" })).toThrow(/taken/);
    svc.createOrder({ ...ok, name: "beta" });
    expect(() => svc.createOrder({ ...ok, name: "gamma" })).toThrow(/every agent has been minted/);
  });

  it("frees the name when an order expires, but still honours a late payment if the name is free", async () => {
    const s = setup();
    const a = s.svc.createOrder({ name: "alpha", preset: "degen", tier: "hosted" });
    s.tick(16 * 60_000);
    expect((await s.svc.orderStatus(a.order.id)).status).toBe("expired");
    s.pay(a.order, 5);
    expect((await s.svc.confirm(a.order.id, sig(5))).status).toBe("paid");

    const t = setup();
    const first = t.svc.createOrder({ name: "alpha", preset: "degen", tier: "hosted" });
    t.tick(16 * 60_000);
    const second = t.svc.createOrder({ name: "alpha", preset: "degen", tier: "hosted" });
    t.pay(second.order, 6);
    await t.svc.confirm(second.order.id, sig(6));
    t.pay(first.order, 7);
    await expect(t.svc.confirm(first.order.id, sig(7))).rejects.toThrow(/Contact the operator/);
  });

  it("keeps the code behind the code tier and the owner token", async () => {
    const s = setup();
    const h = s.svc.createOrder({ name: "alpha", preset: "contrarian", tier: "hosted" });
    await s.svc.confirm(h.order.id, s.pay(h.order, 1));
    expect(() => s.svc.codeBundle("alpha", h.ownerToken)).toThrow(MintError);
    expect(() => s.svc.codeBundle("alpha", "wrong")).toThrow(/wrong owner token/);
    expect(() => s.svc.ownerView("alpha", undefined)).toThrow(/wrong owner token/);

    // Upgrading costs the difference between the tiers.
    expect(() => s.svc.createUpgrade("alpha", "wrong")).toThrow(/wrong owner token/);
    const up = s.svc.createUpgrade("alpha", h.ownerToken);
    expect(BigInt(up.lamports) / 10_000n).toBe(45_000n);
    await s.svc.confirm(up.id, s.pay(up, 2));
    const bundle = s.svc.codeBundle("ALPHA", h.ownerToken);
    expect(bundle.agent).toMatchObject({ name: "alpha", preset: "contrarian" });
    expect(bundle.repository).toBe("https://github.com/acme/swarm");
    // The bundle's config is one this repo's own parser accepts.
    expect(parseConfig(bundle.swarm).groups[0]).toMatchObject({ roster: ["alpha"], bankrollSol: 0.1 });
    expect(() => s.svc.createUpgrade("alpha", h.ownerToken)).toThrow(/already has the code tier/);
  });

  it("invites a code-tier owner to the repository when a GitHub token is set", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetcher = (async (url: string, init: RequestInit) => (calls.push({ url, init }), new Response(null, { status: 201 }))) as unknown as typeof fetch;
    const s = setup({}, { MINT_GITHUB_TOKEN: "ghs_test" }, fetcher);
    const c = s.svc.createOrder({ name: "alpha", preset: "degen", tier: "code", github: "@octo-cat" });
    await s.svc.confirm(c.order.id, s.pay(c.order, 1));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.github.com/repos/acme/swarm/collaborators/octo-cat");
    expect(calls[0]!.init).toMatchObject({ method: "PUT", body: JSON.stringify({ permission: "pull" }) });
    expect(s.svc.ownerView("alpha", c.ownerToken).githubInvite).toMatchObject({ status: "invited" });

    const t = setup();
    const d = t.svc.createOrder({ name: "alpha", preset: "degen", tier: "code", github: "octo-cat" });
    await t.svc.confirm(d.order.id, t.pay(d.order, 1));
    expect(t.svc.ownerView("alpha", d.ownerToken).githubInvite).toMatchObject({ status: "skipped", detail: "MINT_GITHUB_TOKEN is not set" });
  });

  it("deploys minted agents after the config's own groups", async () => {
    const s = setup();
    const a = s.svc.createOrder({ name: "alpha", preset: "sniper", persona: "Quick hands.", tier: "hosted" });
    await s.svc.confirm(a.order.id, s.pay(a.order, 1));
    const specs = expandWithMinted([{ preset: "holder", count: 1, bankrollSol: 1, targets: [{ mint: BONK, symbol: "BONK" }], tasks: ["trade"] }], s.svc.cfg, s.store.agents());
    expect(specs.map((x) => x.id)).toEqual(["holder-1", "alpha"]);
    expect(specs[1]).toMatchObject({ preset: "sniper", persona: "Quick hands.", bankrollSol: 0.1, tasks: ["trade", "report"] });
  });

  it("shares one store file between two processes", () => {
    const dir = mkdtempSync(join(tmpdir(), "mint-"));
    const a = new MintStore(dir);
    const b = new MintStore(dir);
    const s = new MintService({ cfg: mintCfg(), store: a, rpc: chain().rpc });
    const { order } = s.createOrder({ name: "alpha", preset: "degen", tier: "hosted" });
    expect(b.order(order.id)?.name).toBe("alpha");
  });
});

describe("X linking", () => {
  const env = { X_CLIENT_ID: "client", X_CLIENT_SECRET: "shh", MINT_SECRET: "k" };

  /** A stand-in X: one code, one account. */
  function fakeX(account = { id: "42", username: "sol_kev" }) {
    const seen: { url: string; init: RequestInit }[] = [];
    const fetcher = (async (url: string, init: RequestInit = {}) => {
      seen.push({ url, init });
      if (url.endsWith("/2/oauth2/token")) {
        const body = new URLSearchParams(init.body as string);
        if (body.get("grant_type") === "refresh_token") return Response.json({ access_token: "at2", refresh_token: "rt2", expires_in: 7200 });
        if (body.get("code") !== "good-code") return new Response("{}", { status: 400 });
        return Response.json({ access_token: "at1", refresh_token: "rt1", expires_in: 7200 });
      }
      if (url.endsWith("/2/users/me")) return Response.json({ data: account });
      if (url.endsWith("/2/tweets")) return Response.json({ data: { id: "tweet-1" } });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    return { seen, fetcher };
  }

  async function minted(x = fakeX(), e: Record<string, string> = env) {
    const s = setup({}, e, x.fetcher);
    const a = s.svc.createOrder({ name: "alpha", preset: "degen", tier: "hosted" });
    await s.svc.confirm(a.order.id, s.pay(a.order, 1));
    return { ...s, x, token: a.ownerToken };
  }

  it("says why it is unavailable", async () => {
    expect(setup().svc.xUnavailable()).toBe("X linking needs X_CLIENT_ID");
    expect(setup({}, { X_CLIENT_ID: "c" }).svc.xUnavailable()).toBe("X linking needs MINT_SECRET");
    expect(setup({ x: { enabled: false } }, env).svc.xUnavailable()).toBe("X linking is turned off");
    const s = await minted(fakeX(), {});
    expect(() => s.svc.xStart("alpha", s.token)).toThrow(/X_CLIENT_ID/);
    expect(s.svc.info().x).toBe(false);
  });

  it("links an account through PKCE and stores its tokens encrypted", async () => {
    const s = await minted();
    expect(() => s.svc.xStart("alpha", "wrong")).toThrow(/wrong owner token/);
    const url = new URL(s.svc.xStart("alpha", s.token).url);
    expect(url.origin + url.pathname).toBe("https://x.com/i/oauth2/authorize");
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:4600/x/callback");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")).toContain("tweet.write");
    const state = url.searchParams.get("state")!;

    await expect(s.svc.xFinish("made-up", "good-code")).rejects.toThrow(/expired/);
    const linked = await s.svc.xFinish(state, "good-code");
    expect(linked.x).toMatchObject({ handle: "sol_kev" });
    // The verifier sent to X hashes to the challenge from the authorize URL, and the secret went in the header.
    const tokenCall = s.x.seen.find((c) => c.url.endsWith("/2/oauth2/token"))!;
    expect(challengeOf(new URLSearchParams(tokenCall.init.body as string).get("code_verifier")!)).toBe(url.searchParams.get("code_challenge"));
    expect((tokenCall.init.headers as Record<string, string>).authorization).toBe(`Basic ${Buffer.from("client:shh").toString("base64")}`);
    const stored = s.store.agent("alpha")!.x!.tokens;
    expect(stored).not.toContain("at1");
    expect(unseal<{ accessToken: string }>("k", stored).accessToken).toBe("at1");
    // A state works once.
    await expect(s.svc.xFinish(state, "good-code")).rejects.toThrow(/expired/);
  });

  it("drops the link attempt when X refuses the code or it sits too long", async () => {
    const s = await minted();
    const st = new URL(s.svc.xStart("alpha", s.token).url).searchParams.get("state")!;
    await expect(s.svc.xFinish(st, "bad-code")).rejects.toThrow(/token request failed/);
    expect(s.store.agent("alpha")!.x).toBeUndefined();
    const late = new URL(s.svc.xStart("alpha", s.token).url).searchParams.get("state")!;
    s.tick(11 * 60_000);
    await expect(s.svc.xFinish(late, "good-code")).rejects.toThrow(/expired/);
  });

  it("won't link one X account to agents of two different owners", async () => {
    const s = await minted();
    await s.svc.xFinish(new URL(s.svc.xStart("alpha", s.token).url).searchParams.get("state")!, "good-code");
    const b = s.svc.createOrder({ name: "beta", preset: "degen", tier: "hosted" });
    await s.svc.confirm(b.order.id, s.pay(b.order, 2, { keys: ["So11111111111111111111111111111111111111112", TREASURY, b.order.reference] }));
    const st = new URL(s.svc.xStart("beta", b.ownerToken).url).searchParams.get("state")!;
    await expect(s.svc.xFinish(st, "good-code")).rejects.toThrow(/already linked to another owner/);
    // The same wallet's second agent may share it.
    const c = s.svc.createOrder({ name: "gamma", preset: "degen", tier: "hosted" });
    await s.svc.confirm(c.order.id, s.pay(c.order, 3));
    const st2 = new URL(s.svc.xStart("gamma", c.ownerToken).url).searchParams.get("state")!;
    expect((await s.svc.xFinish(st2, "good-code")).x?.handle).toBe("sol_kev");
  });

  it("posts as the linked account, refreshing an expiring token, and unlinks", async () => {
    const s = await minted();
    await expect(s.svc.xPostAs("alpha", "gm")).rejects.toThrow(/no X account linked/);
    await s.svc.xFinish(new URL(s.svc.xStart("alpha", s.token).url).searchParams.get("state")!, "good-code");
    expect(await s.svc.xPostAs("alpha", "gm")).toBe("tweet-1");
    const post = s.x.seen.filter((c) => c.url.endsWith("/2/tweets"));
    expect((post[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer at1");
    s.tick(2 * 3_600_000);
    await s.svc.xPostAs("alpha", "x".repeat(400));
    const last = s.x.seen.filter((c) => c.url.endsWith("/2/tweets")).at(-1)!;
    expect((last.init.headers as Record<string, string>).authorization).toBe("Bearer at2");
    expect(JSON.parse(last.init.body as string).text).toHaveLength(280);
    expect(unseal<{ refreshToken: string }>("k", s.store.agent("alpha")!.x!.tokens).refreshToken).toBe("rt2");

    await expect(s.svc.xUnlink("alpha", "wrong")).rejects.toThrow(/wrong owner token/);
    expect((await s.svc.xUnlink("alpha", s.token)).x).toBeNull();
    expect(s.x.seen.some((c) => c.url.endsWith("/2/oauth2/revoke"))).toBe(true);
    expect(s.store.agent("alpha")!.x).toBeUndefined();
  });

  it("seals values so a wrong key or a changed byte fails", () => {
    const sealed = seal("k", { a: 1 });
    expect(unseal("k", sealed)).toEqual({ a: 1 });
    expect(() => unseal("other", sealed)).toThrow();
    expect(() => unseal("k", sealed.slice(0, -2) + "AA")).toThrow();
  });

  it("labels paper results in the report it posts", () => {
    expect(reportText("alpha", { equitySol: 0.1034, pnlPct: 3.4, open: 2, trades: 17 }, "paper")).toBe("alpha: equity 0.1034 SOL, P&L +3.40%, 2 open, 17 trades (paper trading)");
    expect(reportText("alpha", { equitySol: 0.09, pnlPct: -10, open: 0, trades: 3 }, "live")).toBe("alpha: equity 0.0900 SOL, P&L -10.00%, 0 open, 3 trades");
  });
});

describe("mint server", () => {
  async function serve() {
    const s = setup();
    const server = createServer((req, res) => void mintHandler(s.svc)(req, res));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const call = async (path: string, init: RequestInit = {}) => {
      const res = await fetch(base + path, init);
      const body: any = res.headers.get("content-type")?.includes("json") ? await res.json() : await res.text();
      return { status: res.status, body };
    };
    return { ...s, call, close: () => new Promise((r) => server.close(r)) };
  }
  const post = (body: unknown, token?: string): RequestInit => ({ method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });

  it("serves the page, takes an order through to a minted agent, and guards owner routes", async () => {
    const s = await serve();
    try {
      expect((await s.call("/")).body).toContain("Mint an agent");
      const info = await s.call("/api/mint/config");
      expect(info.body.tiers.map((t: { id: string; priceSol: number }) => [t.id, t.priceSol])).toEqual([["hosted", 0.05], ["code", 0.5]]);

      expect((await s.call("/api/mint/orders", post({ name: "x", preset: "degen", tier: "hosted" }))).status).toBe(400);
      expect((await s.call("/api/mint/orders", { method: "POST", body: "not json" })).status).toBe(400);
      const made = await s.call("/api/mint/orders", post({ name: "alpha", preset: "degen", tier: "hosted" }));
      expect(made.status).toBe(201);
      const { order, ownerToken } = made.body;
      expect(JSON.stringify(made.body)).not.toContain("ownerTokenHash");

      s.pay(order, 1);
      expect((await s.call(`/api/mint/orders/${order.id}/confirm`, post({ signature: sig(1) }))).body.status).toBe("paid");
      expect((await s.call("/api/agents")).body).toEqual([expect.objectContaining({ id: "alpha", tier: "hosted" })]);
      expect(JSON.stringify((await s.call("/api/agents")).body)).not.toContain("Token");

      expect((await s.call("/api/agents/alpha")).status).toBe(403);
      expect((await s.call("/api/agents/alpha", { headers: { authorization: `Bearer ${ownerToken}` } })).body.id).toBe("alpha");
      expect((await s.call("/api/agents/alpha/code", { headers: { authorization: `Bearer ${ownerToken}` } })).status).toBe(402);
      expect((await s.call("/api/agents/alpha/x", post({}, ownerToken))).status).toBe(503);
      expect((await s.call("/api/agents/ghost", { headers: { authorization: `Bearer ${ownerToken}` } })).status).toBe(404);
      const cb = await s.call("/x/callback?state=%3Cscript%3E&code=1");
      expect(cb.body).toContain("X link failed");
      expect(cb.body).not.toContain("<script>");
      expect((await s.call("/nope")).status).toBe(404);
    } finally {
      await s.close();
    }
  });
});
