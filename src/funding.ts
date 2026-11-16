// One funding wallet for the whole swarm. You send SOL to it once; `--fund` tops every
// agent wallet up to its bankroll plus the fee reserve, and `--sweep` sends agents' SOL back.
// Transfers are plain System Program transfers, batched into as few transactions as possible.
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  createSolanaRpc,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Instruction,
  type KeyPairSigner,
} from "@solana/kit";

import { loadKeypairFile, newKeypairBytes } from "./wallets";

const SYSTEM_PROGRAM = address("11111111111111111111111111111111");
export const LAMPORTS = 1_000_000_000;
/** Base fee per signature, plus headroom so a sweep never fails on fees. */
const TX_FEE = 10_000n;
/** Transfers per transaction (keeps each one well under the size limit). */
const PER_TX = 15;
/** Solana won't leave a wallet with a balance between 0 and its rent-exempt minimum, so the funding wallet keeps this much. */
const RENT_MIN = 890_880n;

export const FUNDING_FILE = "_funding.json";

/** Creates the funding wallet once (never overwritten) and loads it. */
export async function ensureFundingWallet(dir: string): Promise<{ signer: KeyPairSigner; created: boolean }> {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, FUNDING_FILE);
  let created = false;
  if (!existsSync(file)) {
    writeFileSync(file, JSON.stringify([...newKeypairBytes()]), { mode: 0o600, flag: "wx" });
    chmodSync(file, 0o600);
    created = true;
  }
  return { signer: await loadKeypairFile(file), created };
}

/** System Program transfer: [u32 2, u64 lamports], accounts [from (signer, writable), to (writable)]. */
export function transferIx(from: KeyPairSigner, to: string, amount: bigint): Instruction {
  const data = new Uint8Array(12);
  const view = new DataView(data.buffer);
  view.setUint32(0, 2, true);
  view.setBigUint64(4, amount, true);
  return {
    programAddress: SYSTEM_PROGRAM,
    accounts: [
      { address: from.address, role: AccountRole.WRITABLE_SIGNER, signer: from } as never,
      { address: address(to), role: AccountRole.WRITABLE },
    ],
    data,
  };
}

export interface Topup {
  id: string;
  to: string;
  lamports: bigint;
}

/** How much each agent needs to reach its target (bankroll + reserve). Agents already at or above it get nothing. */
export function planTopups(agents: { id: string; address: string; targetSol: number; balanceSol: number }[]): Topup[] {
  return agents
    .map((a) => ({ id: a.id, to: a.address, lamports: BigInt(Math.max(0, Math.round((a.targetSol - a.balanceSol) * LAMPORTS))) }))
    .filter((t) => t.lamports > 0n);
}

async function sendAndConfirm(rpcUrl: string, payer: KeyPairSigner, ixs: Instruction[]): Promise<string> {
  const rpc = createSolanaRpc(rpcUrl);
  const { value: blockhash } = await rpc.getLatestBlockhash().send();
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(payer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(ixs as never, m),
  );
  const signed = await signTransactionMessageWithSigners(msg as never);
  const sig = getSignatureFromTransaction(signed as never);
  await rpc.sendTransaction(getBase64EncodedWireTransaction(signed as never), { encoding: "base64", maxRetries: 3n }).send();
  for (let i = 0; i < 60; i++) {
    const { value } = await rpc.getSignatureStatuses([sig]).send();
    const st = value[0];
    if (st?.err) throw new Error(`transaction ${sig} failed: ${JSON.stringify(st.err)}`);
    if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) return sig;
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(`transaction ${sig} not confirmed after 60s (check it on an explorer before retrying)`);
}

export async function balanceLamports(rpcUrl: string, addr: string): Promise<bigint> {
  const { value } = await createSolanaRpc(rpcUrl).getBalance(address(addr)).send();
  return BigInt(value);
}

/** Sends the top-ups from the funding wallet. Returns the transaction signatures. */
export async function distribute(rpcUrl: string, funder: KeyPairSigner, topups: Topup[]): Promise<string[]> {
  const sigs: string[] = [];
  for (let i = 0; i < topups.length; i += PER_TX) {
    const batch = topups.slice(i, i + PER_TX);
    sigs.push(await sendAndConfirm(rpcUrl, funder, batch.map((t) => transferIx(funder, t.to, t.lamports))));
  }
  return sigs;
}

/** Total the funding wallet needs to cover the top-ups plus fees. */
export function fundingNeeded(topups: Topup[]): bigint {
  const txs = BigInt(Math.ceil(topups.length / PER_TX));
  return topups.reduce((a, t) => a + t.lamports, 0n) + txs * TX_FEE + RENT_MIN;
}

/** Waits until the funding wallet holds at least `need` lamports. */
export async function waitForDeposit(rpcUrl: string, addr: string, need: bigint, onTick: (have: bigint) => void, intervalMs = 5_000): Promise<bigint> {
  for (;;) {
    const have = await balanceLamports(rpcUrl, addr);
    if (have >= need) return have;
    onTick(have);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** Sends each agent's SOL (minus its fee) back to the funding wallet. Tokens are left where they are. */
export async function sweep(rpcUrl: string, wallets: Map<string, KeyPairSigner>, to: string): Promise<{ id: string; lamports: bigint; sig: string }[]> {
  const out: { id: string; lamports: bigint; sig: string }[] = [];
  for (const [id, w] of wallets) {
    const bal = await balanceLamports(rpcUrl, w.address);
    const amount = bal - TX_FEE;
    if (amount <= 0n) continue;
    out.push({ id, lamports: amount, sig: await sendAndConfirm(rpcUrl, w, [transferIx(w, to, amount)]) });
  }
  return out;
}
