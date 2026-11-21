// Checks a mint payment on chain. A payment is a plain SOL transfer to the treasury. It is
// tied to its order two ways: by a Solana Pay reference address carried in the transaction,
// or (for a transfer typed by hand) by the order's exact amount, which is unique among open
// orders. Plain JSON-RPC over fetch, so tests can stand in for the chain.
export type Rpc = (method: string, params: unknown[]) => Promise<any>;

export function httpRpc(url: string, fetcher: typeof fetch = fetch): Rpc {
  let id = 0;
  return async (method, params) => {
    const res = await fetcher(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
    if (!res.ok) throw new Error(`rpc ${method} ${res.status}`);
    const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
    if (body.error) throw new Error(`rpc ${method}: ${body.error.message ?? "error"}`);
    return body.result;
  };
}

export interface PaymentCheck {
  signature: string;
  treasury: string;
  lamports: bigint;
  reference: string;
  /** Unix ms the order was created; older transactions are refused. */
  notBefore: number;
}

export type PaymentResult = { ok: true; payer: string; receivedLamports: bigint } | { ok: false; reason: string; retry?: boolean };

/** Reads one transaction and decides whether it pays the order. */
export async function verifyPayment(rpc: Rpc, c: PaymentCheck): Promise<PaymentResult> {
  const tx = await rpc("getTransaction", [c.signature, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 }]);
  if (!tx) return { ok: false, reason: "transaction not found yet", retry: true };
  if (tx.meta?.err) return { ok: false, reason: "transaction failed on chain" };
  const keys: string[] = [...(tx.transaction?.message?.accountKeys ?? []), ...(tx.meta?.loadedAddresses?.writable ?? []), ...(tx.meta?.loadedAddresses?.readonly ?? [])];
  const i = keys.indexOf(c.treasury);
  if (i < 0) return { ok: false, reason: "transaction does not pay the treasury" };
  const pre = tx.meta?.preBalances?.[i];
  const post = tx.meta?.postBalances?.[i];
  if (pre == null || post == null) return { ok: false, reason: "transaction has no balance data" };
  const received = BigInt(post) - BigInt(pre);
  // 60s of slack for clock drift between this server and the cluster.
  if (tx.blockTime != null && tx.blockTime * 1000 < c.notBefore - 60_000) return { ok: false, reason: "transaction is older than the order" };
  const hasRef = keys.includes(c.reference);
  if (hasRef ? received < c.lamports : received !== c.lamports) {
    return { ok: false, reason: hasRef ? `paid ${received} lamports, order needs ${c.lamports}` : `amount must be exactly ${c.lamports} lamports (got ${received})` };
  }
  const payer = keys[0];
  if (!payer) return { ok: false, reason: "transaction has no fee payer" };
  return { ok: true, payer, receivedLamports: received };
}

/** Signatures of confirmed transactions that carry the order's reference address, newest first. */
export async function findByReference(rpc: Rpc, reference: string): Promise<string[]> {
  const rows = (await rpc("getSignaturesForAddress", [reference, { limit: 5, commitment: "confirmed" }])) as { signature: string; err: unknown }[] | null;
  return (rows ?? []).filter((r) => !r.err).map((r) => r.signature);
}

/** A Solana Pay transfer request: wallets that scan or open it send the exact amount with the reference attached. */
export function payUrl(treasury: string, lamports: bigint, reference: string, label: string, message: string): string {
  const q = new URLSearchParams({ amount: lamportsToSol(lamports), reference, label, message });
  return `solana:${treasury}?${q.toString()}`;
}

export function lamportsToSol(l: bigint): string {
  const whole = l / 1_000_000_000n;
  const frac = (l % 1_000_000_000n).toString().padStart(9, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}
