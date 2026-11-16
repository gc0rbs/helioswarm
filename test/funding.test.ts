import { createKeyPairSignerFromBytes } from "@solana/kit";
import { describe, expect, it } from "vitest";

import { fundingNeeded, planTopups, transferIx } from "../src/funding";
import { newKeypairBytes } from "../src/wallets";

describe("funding", () => {
  it("tops each agent up to its target and skips funded ones", () => {
    const t = planTopups([
      { id: "a", address: "A", targetSol: 0.51, balanceSol: 0 },
      { id: "b", address: "B", targetSol: 0.21, balanceSol: 0.1 },
      { id: "c", address: "C", targetSol: 0.21, balanceSol: 0.5 },
    ]);
    expect(t).toEqual([
      { id: "a", to: "A", lamports: 510_000_000n },
      { id: "b", to: "B", lamports: 110_000_000n },
    ]);
    expect(fundingNeeded(t)).toBe(620_000_000n + 10_000n);
  });

  it("encodes a System Program transfer", async () => {
    const from = await createKeyPairSignerFromBytes(newKeypairBytes());
    const ix = transferIx(from, "11111111111111111111111111111112", 1_500_000_000n);
    expect([...ix.data!]).toEqual([2, 0, 0, 0, 0x00, 0x2f, 0x68, 0x59, 0, 0, 0, 0]);
    expect(ix.accounts!.map((a) => a.address)).toEqual([from.address, "11111111111111111111111111111112"]);
  });
});
