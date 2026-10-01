import { describe, expect, it } from "vitest";
import { BorshInstructionCoder, type Idl } from "@coral-xyz/anchor";
import BN from "bn.js";
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createHarvestWithheldTokensToMintInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";

import dcaIdl from "../idl/dca.json" with { type: "json" };
import limitOrderIdl from "../idl/limit_order.json" with { type: "json" };
import { COOK_MINT } from "./config";
import {
  DCA_PROGRAM_ID,
  assertCloseTxTrustworthy,
  assertOpenTxTrustworthy,
  dcaPda,
  dcaReservePda,
} from "./dca";
import {
  LIMIT_ORDER_PROGRAM_ID,
  assertCancelTxTrustworthy,
  assertPlaceTxTrustworthy,
  orderPda,
  reservePda,
  type ExpectedPlace,
} from "./limitOrders";
import {
  harvestIxMatcher,
  netOfTransferFee,
  resizeForTaxedDeposit,
  transferFeeOn,
} from "./transferFee";

const COOK = new PublicKey(COOK_MINT);
/** Token-2022, 3% transfer fee. */
const TAXED = new PublicKey("6ogGUNxjaTn9geV1dZYpbPkwhLxYKuq6ZB7PeoMyzM1H");
const tax3 = { bps: 300, maxFee: 0xffff_ffff_ffff_ffffn };
const owner = Keypair.generate();
const base = Keypair.generate();
const taxedAta = getAssociatedTokenAddressSync(TAXED, owner.publicKey, true, TOKEN_2022_PROGRAM_ID);
const cu = ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 });
const k = (pubkey: PublicKey, isSigner = false, isWritable = false) => ({
  pubkey,
  isSigner,
  isWritable,
});

function compile(ixs: TransactionInstruction[], signers: Keypair[] = [base]) {
  const tx = new VersionedTransaction(
    new TransactionMessage({
      payerKey: owner.publicKey,
      recentBlockhash: "11111111111111111111111111111111",
      instructions: ixs,
    }).compileToV0Message(),
  );
  if (signers.length) tx.sign(signers);
  return tx;
}

describe("transfer-fee math", () => {
  it("rounds the fee up, as Token-2022 does", () => {
    expect(transferFeeOn(100n, tax3)).toBe(3n);
    expect(transferFeeOn(101n, tax3)).toBe(4n);
    expect(netOfTransferFee(1_000_000_000n, tax3)).toBe(970_000_000n);
    expect(transferFeeOn(1_000n, null)).toBe(0n);
  });

  // The SAME vectors as cookiebox `src/solana/dca/schedules.test.ts`: the agg's builder applies that
  // function, and our verifier expects this one's result — a drift refuses every taxed open.
  it("resizes a taxed DCA exactly like the agg's builder", () => {
    const out = resizeForTaxedDeposit(
      { inDeposited: 1_000n, inAmountPerCycle: 100n, minOutAmount: 1_001n, maxOutAmount: 2_001n },
      tax3,
    );
    expect(out).toEqual({
      inDeposited: 1_000n,
      inAmountPerCycle: 97n,
      minOutAmount: 971n,
      maxOutAmount: 1_940n,
    });
    // The live-verified case: 1,000 tokens over 10 cycles → 97 per cycle on the 970 that arrive.
    expect(
      resizeForTaxedDeposit(
        {
          inDeposited: 1_000_000_000n,
          inAmountPerCycle: 100_000_000n,
          minOutAmount: 0n,
          maxOutAmount: 0n,
        },
        tax3,
      ).inAmountPerCycle,
    ).toBe(97_000_000n);
    const s = { inDeposited: 1_000n, inAmountPerCycle: 100n, minOutAmount: 5n, maxOutAmount: 0n };
    expect(resizeForTaxedDeposit(s, null)).toBe(s);
  });
});

describe("harvestIxMatcher", () => {
  const reserve = Keypair.generate().publicKey;
  const ok = harvestIxMatcher(TAXED, reserve);
  const decoded = (ix: TransactionInstruction) => ({
    programId: ix.programId,
    keys: ix.keys.map((x) => x.pubkey),
    data: Buffer.from(ix.data),
  });

  it("accepts the harvest of exactly our reserve into its mint", () => {
    const ix = createHarvestWithheldTokensToMintInstruction(
      TAXED,
      [reserve],
      TOKEN_2022_PROGRAM_ID,
    );
    expect(ok(decoded(ix))).toBe(true);
  });

  it("refuses another account, extra sources, another mint, or any other Token-2022 ix", () => {
    const other = Keypair.generate().publicKey;
    const h = (mint: PublicKey, srcs: PublicKey[]) =>
      decoded(createHarvestWithheldTokensToMintInstruction(mint, srcs, TOKEN_2022_PROGRAM_ID));
    expect(ok(h(TAXED, [other]))).toBe(false);
    expect(ok(h(TAXED, [reserve, other]))).toBe(false);
    expect(ok(h(other, [reserve]))).toBe(false);
    const transfer = createTransferCheckedInstruction(
      taxedAta,
      TAXED,
      reserve,
      owner.publicKey,
      1n,
      6,
      [],
      TOKEN_2022_PROGRAM_ID,
    );
    expect(ok(decoded(transfer))).toBe(false);
  });
});

// --- limit orders on a taxed mint -----------------------------------------------------------------

const loCoder = new BorshInstructionCoder(limitOrderIdl as Idl);
const order = orderPda(base.publicKey);

function placeIx(makerInput = taxedAta): TransactionInstruction {
  return new TransactionInstruction({
    programId: LIMIT_ORDER_PROGRAM_ID,
    keys: [
      k(base.publicKey, true),
      k(owner.publicKey, true, true),
      k(order, false, true),
      k(reservePda(order), false, true),
      k(makerInput, false, true),
      k(owner.publicKey),
      k(TAXED),
      k(COOK),
      k(TOKEN_2022_PROGRAM_ID),
      k(TOKEN_PROGRAM_ID),
      k(SystemProgram.programId),
    ],
    data: loCoder.encode("initialize_order", {
      making_amount: new BN(1_000_000_000),
      taking_amount: new BN(280_000_000),
      expired_at: null,
      kind: 0,
      refund_native: false,
      trigger_taking_amount: new BN(0),
    }),
  });
}
const harvest = (acc: PublicKey) =>
  createHarvestWithheldTokensToMintInstruction(TAXED, [acc], TOKEN_2022_PROGRAM_ID);

// Selling a taxed token for native COOK — the shape cookiebox's `buildPlaceOrderIxs` builds.
const expectedSell: ExpectedPlace = {
  owner: owner.publicKey,
  inputMint: TAXED,
  outputMint: COOK,
  makingAmount: 1_000_000_000n,
  takingAmount: 280_000_000n,
  triggerTakingAmount: 0n,
  kind: "limit",
  expiredAt: null,
  refundNative: false,
  payoutNative: true,
  order,
  inputTokenProgram: TOKEN_2022_PROGRAM_ID,
  outputTokenProgram: TOKEN_PROGRAM_ID,
  inputTaxed: true,
};

describe("assertPlaceTxTrustworthy on a transfer-fee input", () => {
  it("accepts place + harvest of our own reserve, with our Token-2022 ATA as the input", () => {
    const tx = compile([cu, placeIx(), harvest(reservePda(order))]);
    expect(() => assertPlaceTxTrustworthy(tx, expectedSell)).not.toThrow();
  });

  it("refuses a harvest of any other account", () => {
    const tx = compile([cu, placeIx(), harvest(Keypair.generate().publicKey)]);
    expect(() => assertPlaceTxTrustworthy(tx, expectedSell)).toThrow(/unexpected program/);
  });

  it("refuses a Token-2022 instruction when the input was not read as taxed", () => {
    const tx = compile([cu, placeIx(), harvest(reservePda(order))]);
    expect(() => assertPlaceTxTrustworthy(tx, { ...expectedSell, inputTaxed: false })).toThrow(
      /unexpected program/,
    );
  });

  it("derives our input ATA under the mint's own program (a classic-program ATA is refused)", () => {
    const classicAta = getAssociatedTokenAddressSync(TAXED, owner.publicKey, true);
    const tx = compile([cu, placeIx(classicAta), harvest(reservePda(order))]);
    expect(() => assertPlaceTxTrustworthy(tx, expectedSell)).toThrow(/input account/);
    // …and without the program hint the Token-2022 ATA is refused, which is why callers pass it.
    const good = compile([cu, placeIx(), harvest(reservePda(order))]);
    expect(() =>
      assertPlaceTxTrustworthy(good, { ...expectedSell, inputTokenProgram: undefined }),
    ).toThrow(/input account/);
  });

  it("allows a Token-2022 ATA create for our own account (a taxed output)", () => {
    const tx = compile([
      cu,
      createAssociatedTokenAccountIdempotentInstruction(
        owner.publicKey,
        taxedAta,
        owner.publicKey,
        TAXED,
        TOKEN_2022_PROGRAM_ID,
      ),
      placeIx(),
      harvest(reservePda(order)),
    ]);
    expect(() => assertPlaceTxTrustworthy(tx, expectedSell)).not.toThrow();
  });
});

describe("assertCancelTxTrustworthy on a transfer-fee input", () => {
  const cancel = new TransactionInstruction({
    programId: LIMIT_ORDER_PROGRAM_ID,
    keys: [
      k(order, false, true),
      k(owner.publicKey, true, true),
      k(reservePda(order), false, true),
      k(taxedAta, false, true),
      k(TAXED),
      k(TOKEN_2022_PROGRAM_ID),
    ],
    data: loCoder.encode("cancel_order", {}),
  });

  it("accepts the harvest the close needs, only for this order's reserve", () => {
    const exp = { owner: owner.publicKey, order, inputMint: TAXED, inputTaxed: true };
    expect(() =>
      assertCancelTxTrustworthy(compile([cu, harvest(reservePda(order)), cancel], []), exp),
    ).not.toThrow();
    expect(() =>
      assertCancelTxTrustworthy(
        compile([cu, harvest(Keypair.generate().publicKey), cancel], []),
        exp,
      ),
    ).toThrow(/unexpected program/);
    expect(() =>
      assertCancelTxTrustworthy(compile([cu, harvest(reservePda(order)), cancel], []), {
        owner: owner.publicKey,
        order,
      }),
    ).toThrow(/unexpected program/);
  });
});

// --- DCA on a taxed mint --------------------------------------------------------------------------

const dcaCoder = new BorshInstructionCoder(dcaIdl as Idl);
const dca = dcaPda(base.publicKey);
const sized = resizeForTaxedDeposit(
  {
    inDeposited: 1_000_000_000n,
    inAmountPerCycle: 100_000_000n,
    minOutAmount: 30_000_000n,
    maxOutAmount: 0n,
  },
  tax3,
);

function openIx(per: bigint, minOut: bigint): TransactionInstruction {
  return new TransactionInstruction({
    programId: DCA_PROGRAM_ID,
    keys: [
      k(base.publicKey, true),
      k(owner.publicKey, true, true),
      k(dca, false, true),
      k(dcaReservePda(dca), false, true),
      k(taxedAta, false, true),
      k(owner.publicKey),
      k(TAXED),
      k(COOK),
      k(TOKEN_2022_PROGRAM_ID),
      k(TOKEN_PROGRAM_ID),
      k(SystemProgram.programId),
    ],
    data: dcaCoder.encode("open_dca", {
      in_deposited: new BN(1_000_000_000),
      in_amount_per_cycle: new BN(per.toString()),
      cycle_frequency: new BN(3600),
      min_out_amount: new BN(minOut.toString()),
      max_out_amount: new BN(0),
      start_at: new BN(0),
      refund_native: false,
    }),
  });
}

describe("DCA verifiers on a transfer-fee input", () => {
  const exp = {
    owner: owner.publicKey,
    inputMint: TAXED,
    outputMint: COOK,
    inDeposited: 1_000_000_000n,
    inAmountPerCycle: sized.inAmountPerCycle,
    cycleFrequency: 3600,
    minOut: sized.minOutAmount,
    maxOut: 0n,
    startAt: 0,
    refundNative: false,
    payoutNative: true,
    dca,
    inputTokenProgram: TOKEN_2022_PROGRAM_ID,
    outputTokenProgram: TOKEN_PROGRAM_ID,
    inputTaxed: true,
  };
  const reserveHarvest = harvest(dcaReservePda(dca));

  it("accepts the agg's re-sized open (97 per cycle, band scaled) plus the reserve harvest", () => {
    expect(sized.inAmountPerCycle).toBe(97_000_000n);
    const tx = compile([cu, openIx(sized.inAmountPerCycle, sized.minOutAmount), reserveHarvest]);
    expect(() => assertOpenTxTrustworthy(tx, exp)).not.toThrow();
  });

  it("refuses a build that kept the gross slice or the unscaled band", () => {
    expect(() =>
      assertOpenTxTrustworthy(
        compile([cu, openIx(100_000_000n, sized.minOutAmount), reserveHarvest]),
        exp,
      ),
    ).toThrow(/amount per cycle/);
    expect(() =>
      assertOpenTxTrustworthy(
        compile([cu, openIx(sized.inAmountPerCycle, 30_000_000n), reserveHarvest]),
        exp,
      ),
    ).toThrow(/minimum output/);
  });

  it("close: refund to our Token-2022 ATA, harvest of this schedule's reserve only", () => {
    const close = new TransactionInstruction({
      programId: DCA_PROGRAM_ID,
      keys: [
        k(dca, false, true),
        k(owner.publicKey, true, true),
        k(dcaReservePda(dca), false, true),
        k(taxedAta, false, true),
        k(TAXED),
        k(TOKEN_2022_PROGRAM_ID),
      ],
      data: dcaCoder.encode("close_dca", {}),
    });
    const cexp = {
      owner: owner.publicKey,
      dca,
      inputMint: TAXED,
      refundNative: false,
      inputTokenProgram: TOKEN_2022_PROGRAM_ID,
      inputTaxed: true,
    };
    expect(() =>
      assertCloseTxTrustworthy(compile([cu, reserveHarvest, close], []), cexp),
    ).not.toThrow();
    expect(() =>
      assertCloseTxTrustworthy(compile([cu, reserveHarvest, close], []), {
        ...cexp,
        inputTokenProgram: undefined,
      }),
    ).toThrow(/refund account/);
    expect(() =>
      assertCloseTxTrustworthy(
        compile([cu, harvest(Keypair.generate().publicKey), close], []),
        cexp,
      ),
    ).toThrow(/unexpected program/);
  });
});
