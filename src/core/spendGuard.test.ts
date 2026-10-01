import {
  ACCOUNT_SIZE,
  AccountLayout,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Keypair,
  PublicKey,
  StakeProgram,
  SystemProgram,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
  type Connection,
} from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";

import { CookieMcpError } from "./errors";
import {
  NATIVE_FEE_ALLOWANCE,
  assertQuotedMinimum,
  assessSpend,
  minOutFloor,
  nativeBudget,
  parseTokenAccount,
  simulateWithinBudget,
  spendBudget,
  type AccountState,
} from "./spendGuard";

const WALLET = Keypair.generate().publicKey;
const W = WALLET.toBase58();
const ATTACKER = Keypair.generate().publicKey;
const MINT_A = Keypair.generate().publicKey;
const MINT_B = Keypair.generate().publicKey;
const NATIVE = NATIVE_MINT.toBase58();

function walletState(lamports: bigint): AccountState {
  return { lamports, program: SystemProgram.programId.toBase58(), data: Buffer.alloc(0) };
}

function tokenState(
  mint: PublicKey,
  amount: bigint,
  opts: { owner?: PublicKey; delegate?: PublicKey; closeAuthority?: PublicKey } = {},
): AccountState {
  const data = Buffer.alloc(ACCOUNT_SIZE);
  AccountLayout.encode(
    {
      mint,
      owner: opts.owner ?? WALLET,
      amount,
      delegateOption: opts.delegate ? 1 : 0,
      delegate: opts.delegate ?? PublicKey.default,
      state: 1,
      isNativeOption: mint.equals(NATIVE_MINT) ? 1 : 0,
      isNative: mint.equals(NATIVE_MINT) ? 2_039_280n : 0n,
      delegatedAmount: 0n,
      closeAuthorityOption: opts.closeAuthority ? 1 : 0,
      closeAuthority: opts.closeAuthority ?? PublicKey.default,
    },
    data,
  );
  return { lamports: 2_039_280n, program: TOKEN_PROGRAM_ID.toBase58(), data };
}

/** pre/post maps over the wallet + named accounts. */
function states(
  pre: Record<string, AccountState | null>,
  post: Record<string, AccountState | null>,
): [Map<string, AccountState | null>, Map<string, AccountState | null>] {
  return [new Map(Object.entries(pre)), new Map(Object.entries(post))];
}

describe("parseTokenAccount", () => {
  it("reads mint, owner, amount, delegate and close authority at their layout offsets", () => {
    const view = parseTokenAccount(tokenState(MINT_A, 42n, { delegate: ATTACKER }));
    expect(view).toEqual({
      mint: MINT_A.toBase58(),
      owner: W,
      amount: 42n,
      delegate: ATTACKER.toBase58(),
      closeAuthority: null,
    });
  });

  it("reads a Token-2022 account that carries extensions, and not a Token-2022 mint", () => {
    const base = tokenState(MINT_A, 7n);
    // Extensions follow an account-type byte at 165: 2 = account, 1 = mint.
    const account: AccountState = {
      ...base,
      program: TOKEN_2022_PROGRAM_ID.toBase58(),
      data: Buffer.concat([base.data, Buffer.from([2, 0, 0, 0, 0, 0, 0, 0])]),
    };
    expect(parseTokenAccount(account)?.amount).toBe(7n);
    const mintLike: AccountState = {
      ...account,
      data: Buffer.concat([base.data, Buffer.from([1, 0, 0, 0])]),
    };
    expect(parseTokenAccount(mintLike)).toBeNull();
    // Plain SPL Token never has a byte 165, so a longer buffer is not an account.
    expect(parseTokenAccount({ ...account, program: TOKEN_PROGRAM_ID.toBase58() })).toBeNull();
  });

  it("ignores accounts that are not token accounts", () => {
    expect(parseTokenAccount(walletState(1n))).toBeNull();
    expect(parseTokenAccount(null)).toBeNull();
    const multisig = { ...tokenState(MINT_A, 1n), data: Buffer.alloc(355) };
    expect(parseTokenAccount(multisig)).toBeNull();
  });
});

describe("assessSpend", () => {
  const ataA = Keypair.generate().publicKey.toBase58();
  const ataB = Keypair.generate().publicKey.toBase58();
  const wcook = Keypair.generate().publicKey.toBase58();

  it("passes an honest A → B swap", () => {
    const [pre, post] = states(
      { [W]: walletState(1_000_000_000n), [ataA]: tokenState(MINT_A, 500n), [ataB]: null },
      {
        [W]: walletState(1_000_000_000n - 2_044_280n), // fee + the new ATA's rent
        [ataA]: tokenState(MINT_A, 0n),
        [ataB]: tokenState(MINT_B, 990n),
      },
    );
    const budget = spendBudget(MINT_A.toBase58(), 500n, 0n, { mint: MINT_B.toBase58(), min: 980n });
    expect(assessSpend(W, pre, post, budget)).toBeNull();
  });

  it("refuses taking more of the input than requested", () => {
    const [pre, post] = states(
      { [W]: walletState(1n << 40n), [ataA]: tokenState(MINT_A, 1_000n) },
      { [W]: walletState(1n << 40n), [ataA]: tokenState(MINT_A, 0n) },
    );
    expect(assessSpend(W, pre, post, spendBudget(MINT_A.toBase58(), 500n))).toMatch(
      /1000 base units .* more than the 500 requested/,
    );
  });

  it("refuses draining a token the request never mentioned", () => {
    const [pre, post] = states(
      {
        [W]: walletState(1n << 40n),
        [ataA]: tokenState(MINT_A, 500n),
        [ataB]: tokenState(MINT_B, 7n),
      },
      {
        [W]: walletState(1n << 40n),
        [ataA]: tokenState(MINT_A, 0n),
        [ataB]: tokenState(MINT_B, 0n),
      },
    );
    expect(assessSpend(W, pre, post, spendBudget(MINT_A.toBase58(), 500n))).toMatch(
      new RegExp(MINT_B.toBase58()),
    );
  });

  it("refuses an extra native transfer beyond the fee allowance", () => {
    const start = 10_000_000_000n;
    const [pre, post] = states(
      { [W]: walletState(start), [ataA]: tokenState(MINT_A, 500n) },
      { [W]: walletState(start - NATIVE_FEE_ALLOWANCE - 1n), [ataA]: tokenState(MINT_A, 0n) },
    );
    expect(assessSpend(W, pre, post, spendBudget(MINT_A.toBase58(), 500n))).toMatch(/native/);
  });

  it("counts wrapped native with the wallet: closing our wCOOK into the wallet is no loss", () => {
    const [pre, post] = states(
      { [W]: walletState(1_000_000n), [wcook]: tokenState(NATIVE_MINT, 5_000_000n) },
      { [W]: walletState(1_000_000n + 5_000_000n + 2_039_280n - 5_000n), [wcook]: null },
    );
    expect(assessSpend(W, pre, post, nativeBudget(0n))).toBeNull();
  });

  it("refuses closing our wCOOK into someone else's wallet", () => {
    const [pre, post] = states(
      { [W]: walletState(1_000_000n), [wcook]: tokenState(NATIVE_MINT, 5_000_000_000n) },
      { [W]: walletState(1_000_000n - 5_000n), [wcook]: null },
    );
    expect(assessSpend(W, pre, post, nativeBudget(0n))).toMatch(/native/);
  });

  it("counts closing one of our token accounts as losing its whole balance", () => {
    const [pre, post] = states(
      { [W]: walletState(10n ** 9n), ataA: tokenState(MINT_A, 500n) },
      { [W]: walletState(10n ** 9n + 2_039_280n), ataA: null },
    );
    // Not the mint the request spends → a loss of 500 base units of A, refused.
    expect(assessSpend(W, pre, post, spendBudget(MINT_B.toBase58(), 1n))).toMatch(
      /take 500 base units of/,
    );
    // The mint it does spend → within the amount asked for.
    expect(assessSpend(W, pre, post, spendBudget(MINT_A.toBase58(), 500n))).toBeNull();
  });

  it("refuses handing a token account to another owner", () => {
    const [pre, post] = states(
      { [W]: walletState(1n << 40n), [ataB]: tokenState(MINT_B, 7n) },
      { [W]: walletState(1n << 40n), [ataB]: tokenState(MINT_B, 7n, { owner: ATTACKER }) },
    );
    expect(assessSpend(W, pre, post, nativeBudget(0n))).toMatch(/hand our token account/);
  });

  it("refuses a new delegate or close authority, but not one that was already there", () => {
    const [pre, post] = states(
      { [W]: walletState(1n << 40n), [ataB]: tokenState(MINT_B, 7n) },
      { [W]: walletState(1n << 40n), [ataB]: tokenState(MINT_B, 7n, { delegate: ATTACKER }) },
    );
    expect(assessSpend(W, pre, post, nativeBudget(0n))).toMatch(/delegate/);
    const [pre2, post2] = states(
      { [W]: walletState(1n << 40n), [ataB]: tokenState(MINT_B, 7n) },
      { [W]: walletState(1n << 40n), [ataB]: tokenState(MINT_B, 7n, { closeAuthority: ATTACKER }) },
    );
    expect(assessSpend(W, pre2, post2, nativeBudget(0n))).toMatch(/close authority/);
    const had = tokenState(MINT_B, 7n, { delegate: ATTACKER });
    const [pre3, post3] = states(
      { [W]: walletState(1n << 40n), [ataB]: had },
      { [W]: walletState(1n << 40n), [ataB]: had },
    );
    expect(assessSpend(W, pre3, post3, nativeBudget(0n))).toBeNull();
  });

  it("refuses reassigning the wallet to another program", () => {
    const [pre, post] = states(
      { [W]: walletState(1n << 40n) },
      { [W]: { ...walletState(1n << 40n), program: ATTACKER.toBase58() } },
    );
    expect(assessSpend(W, pre, post, nativeBudget(0n))).toMatch(/reassign the wallet/);
  });

  it("refuses a swap whose output never arrives", () => {
    const [pre, post] = states(
      { [W]: walletState(1n << 40n), [ataA]: tokenState(MINT_A, 500n), [ataB]: null },
      {
        [W]: walletState(1n << 40n),
        [ataA]: tokenState(MINT_A, 0n),
        [ataB]: tokenState(MINT_B, 1n),
      },
    );
    const budget = spendBudget(MINT_A.toBase58(), 500n, 0n, { mint: MINT_B.toBase58(), min: 980n });
    expect(assessSpend(W, pre, post, budget)).toMatch(/less than the quoted minimum 980/);
  });

  it("checks a native output net of the fee allowance", () => {
    const start = 1_000_000_000n;
    const [pre, post] = states(
      { [W]: walletState(start), [ataA]: tokenState(MINT_A, 500n) },
      { [W]: walletState(start + 50_000_000n - 10_000n), [ataA]: tokenState(MINT_A, 0n) },
    );
    const ok = spendBudget(MINT_A.toBase58(), 500n, 0n, { mint: NATIVE, min: 50_000_000n });
    expect(assessSpend(W, pre, post, ok)).toBeNull();
    const [pre2, post2] = states(
      { [W]: walletState(start), [ataA]: tokenState(MINT_A, 500n) },
      { [W]: walletState(start - 10_000n), [ataA]: tokenState(MINT_A, 0n) },
    );
    expect(assessSpend(W, pre2, post2, ok)).toMatch(/quoted minimum/);
  });

  it("budgets a native input as amount + allowance", () => {
    expect(spendBudget(NATIVE, 5n)).toEqual({ native: NATIVE_FEE_ALLOWANCE + 5n });
    expect(nativeBudget(5n, 7n)).toEqual({ native: NATIVE_FEE_ALLOWANCE + 12n });
  });
});

describe("minOutFloor / assertQuotedMinimum", () => {
  it("floors totalOut × (1 − slippage), as both aggregators and Jupiter compute it", () => {
    // Candy Shop live: 730799800 at 100 bps → 723491802.
    expect(minOutFloor(730_799_800n, 100)).toBe(723_491_802n);
    expect(minOutFloor(1_000n, 0)).toBe(1_000n);
    expect(minOutFloor(999n, 50)).toBe(994n);
  });

  it("accepts a quote at or above the floor and refuses one below it", () => {
    const quote = { totalOutAmount: "730799800", minOutAmount: "723491802" };
    expect(assertQuotedMinimum(quote, 100, "Candy Shop")).toBe(723_491_802n);
    // Cookiebox quotes its minimum off the gross amount, which lands above the floor.
    expect(assertQuotedMinimum({ ...quote, minOutAmount: "724941685" }, 100, "agg")).toBe(
      724_941_685n,
    );
    expect(() => assertQuotedMinimum({ ...quote, minOutAmount: "723491801" }, 100, "x")).toThrow(
      /minimum output 723491801 is below the 723491802/,
    );
    expect(() => assertQuotedMinimum({ ...quote, minOutAmount: "1" }, 100, "x")).toThrow(
      CookieMcpError,
    );
  });
});

describe("simulateWithinBudget", () => {
  const BLOCKHASH = "EkPafx58mgwkEnGwo62jXhXDAdJ37Z8G8MFBRPsr9uhz";

  function legacyTx(
    feePayer: PublicKey,
    ix = SystemProgram.transfer({ fromPubkey: WALLET, toPubkey: ATTACKER, lamports: 1 }),
  ) {
    const tx = new Transaction({ feePayer, blockhash: BLOCKHASH, lastValidBlockHeight: 1 });
    tx.add(ix);
    return tx;
  }

  function v0Tx(
    ixs = [SystemProgram.transfer({ fromPubkey: WALLET, toPubkey: ATTACKER, lamports: 1 })],
  ) {
    const msg = new TransactionMessage({
      payerKey: WALLET,
      recentBlockhash: BLOCKHASH,
      instructions: ixs,
    }).compileToV0Message();
    return new VersionedTransaction(msg);
  }

  /** A connection whose reads return `pre` and whose simulation returns `post` for the same keys. */
  function conn(
    pre: Record<string, AccountState | null>,
    post: Record<string, AccountState | null> | "short",
  ) {
    const toInfo = (s: AccountState | null) =>
      s
        ? {
            lamports: Number(s.lamports),
            owner: new PublicKey(s.program),
            data: s.data,
            executable: false,
          }
        : null;
    const simulate = vi.fn(async (_tx: unknown, cfg: { accounts: { addresses: string[] } }) => ({
      value: {
        err: null,
        logs: [],
        accounts:
          post === "short"
            ? []
            : cfg.accounts.addresses.map((a) => {
                const s = post[a] ?? null;
                return s
                  ? {
                      lamports: Number(s.lamports),
                      owner: s.program,
                      data: [s.data.toString("base64"), "base64"],
                    }
                  : null;
              }),
      },
    }));
    const c = {
      getAddressLookupTable: vi.fn(),
      getMultipleAccountsInfo: vi.fn(async (keys: PublicKey[]) =>
        keys.map((k) => toInfo(pre[k.toBase58()] ?? null)),
      ),
      simulateTransaction: simulate,
    };
    return { conn: c as unknown as Connection, simulate };
  }

  const opts = { what: "swap", source: "test API", commitment: "confirmed" as const };

  it("refuses a build whose fee payer is not the wallet, before any RPC call", async () => {
    const c = conn({}, {});
    await expect(
      simulateWithinBudget(c.conn, legacyTx(ATTACKER), WALLET, nativeBudget(1n), opts),
    ).rejects.toThrow(/fee payer is .*, not this wallet/);
    expect(c.simulate).not.toHaveBeenCalled();
  });

  it("refuses a build that invokes the stake program", async () => {
    const stakeAccount = Keypair.generate().publicKey;
    const ix = StakeProgram.authorize({
      stakePubkey: stakeAccount,
      authorizedPubkey: WALLET,
      newAuthorizedPubkey: ATTACKER,
      stakeAuthorizationType: { index: 0 },
    }).instructions[0]!;
    const c = conn({}, {});
    await expect(
      simulateWithinBudget(c.conn, v0Tx([ix]), WALLET, nativeBudget(0n), opts),
    ).rejects.toThrow(/invokes the stake program/);
  });

  it("refuses a build that writes to a stake-owned account through any program", async () => {
    const stakeAccount = Keypair.generate().publicKey;
    // A plain transfer *to* the stake account: the stake program is nowhere in the instruction list.
    const ix = SystemProgram.transfer({ fromPubkey: WALLET, toPubkey: stakeAccount, lamports: 1 });
    const pre = {
      [W]: walletState(10n ** 9n),
      [stakeAccount.toBase58()]: {
        lamports: 1n,
        program: StakeProgram.programId.toBase58(),
        data: Buffer.alloc(200),
      },
    };
    const c = conn(pre, pre);
    await expect(
      simulateWithinBudget(c.conn, v0Tx([ix]), WALLET, nativeBudget(1n), opts),
    ).rejects.toThrow(/an account owned by the stake program/);
    expect(c.simulate).not.toHaveBeenCalled();
  });

  it("simulates a legacy build through the versioned path, with the commitment and account request", async () => {
    const pre = { [W]: walletState(10n ** 9n), [ATTACKER.toBase58()]: null };
    const post = { ...pre, [W]: walletState(10n ** 9n - 1n - 5_000n) };
    const c = conn(pre, post);
    const sim = await simulateWithinBudget(
      c.conn,
      legacyTx(WALLET),
      WALLET,
      nativeBudget(1n),
      opts,
    );
    expect(sim.value.err).toBeNull();
    const [simTx, cfg] = c.simulate.mock.calls[0]!;
    expect(simTx).toBeInstanceOf(VersionedTransaction);
    expect(cfg).toMatchObject({
      commitment: "confirmed",
      sigVerify: false,
      replaceRecentBlockhash: true,
      accounts: { encoding: "base64", addresses: [W, ATTACKER.toBase58()] },
    });
  });

  it("fails closed when the RPC returns no account state", async () => {
    const pre = { [W]: walletState(10n ** 9n), [ATTACKER.toBase58()]: null };
    const c = conn(pre, "short");
    await expect(
      simulateWithinBudget(c.conn, v0Tx(), WALLET, nativeBudget(1n), opts),
    ).rejects.toThrow(/did not return the simulated account state/);
  });

  it("refuses when the wallet no longer exists after the build", async () => {
    const pre = { [W]: walletState(10n ** 9n), [ATTACKER.toBase58()]: null };
    const post = { ...pre, [W]: null };
    const c = conn(pre, post);
    await expect(
      simulateWithinBudget(c.conn, v0Tx(), WALLET, nativeBudget(1n), opts),
    ).rejects.toThrow(/would take 1000000000 native base units/);
  });
});
