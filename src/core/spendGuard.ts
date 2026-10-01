// What an API-built transaction may do to OUR wallet, checked against its own simulation.
//
// Swaps (Candy Shop, the Cookiebox aggregator, Jupiter) and every MomoSwap launchpad action come back
// from a remote API as a finished transaction. A successful simulation proves it executes, not what
// it executes: a build that also drains the wallet, hands a token account to someone else or sets a
// delegate on it simulates just as cleanly. Decoding every instruction (as `txVerify.ts` does for the
// escrow flows) does not scale to swaps — a route can cross any DEX program — so this checks the one
// thing that matters regardless of route: the state of the accounts we own, before vs after.
//
// Before signing, every writable account the transaction touches (lookup tables resolved from the
// chain, not from the API) is read, the transaction is simulated with those accounts' post-state
// returned, and the build is refused when:
//   - the fee payer is not our wallet, or it invokes the stake / vote / upgradeable-loader programs,
//     or writes to an account one of them owns (a route program could reach them by CPI with our
//     signature, which the top-level program list never shows);
//   - the wallet stops being a plain system account (Assign / Allocate);
//   - one of our token accounts changes owner, or gains a delegate or close authority it did not have;
//   - native value (wallet lamports + wrapped native) drops by more than the budget (the requested
//     spend plus a fee/rent allowance), or any other token we hold drops by more than its budget;
//   - the expected output does not arrive (at least the quote's minimum).
import { ASSOCIATED_TOKEN_PROGRAM_ID, NATIVE_MINT } from "@solana/spl-token";
import {
  PublicKey,
  SystemProgram,
  Transaction,
  VersionedTransaction,
  type AccountInfo,
  type AddressLookupTableAccount,
  type Commitment,
  type Connection,
  type MessageV0,
  type SimulatedTransactionResponse,
} from "@solana/web3.js";

import { CookieMcpError } from "./errors";

const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const ACCOUNT_LEN = 165;

/** Programs no swap or launchpad action has any reason to call, and that grant lasting authority. */
const FORBIDDEN_PROGRAMS = new Map([
  ["Stake11111111111111111111111111111111111111", "the stake program"],
  ["Vote111111111111111111111111111111111111111", "the vote program"],
  ["BPFLoaderUpgradeab1e11111111111111111111111", "the upgradeable loader"],
]);

/**
 * Network fees, priority fees and rent for the few accounts a swap or a launchpad action opens
 * (ATAs, a position PDA, a temporary wrapped-native account). Generous for that, and the most a
 * hostile build could take beyond what was asked.
 */
export const NATIVE_FEE_ALLOWANCE = 20_000_000n;

/** Rent for the accounts a launch creates (pool, vaults, metadata — ~0.03 COOK measured), plus margin. */
export const LAUNCH_RENT_ALLOWANCE = 100_000_000n;

export interface SpendBudget {
  /** Max net decrease of native value (wallet lamports + wrapped native), fees and rent included. */
  native: bigint;
  /** Max net decrease per other mint (base58 → base units). A mint not listed may not decrease. */
  tokens?: ReadonlyMap<string, bigint>;
  /** The output that must arrive: a net increase of at least `min` (native: net of the allowance). */
  receive?: { mint: string; min: bigint };
}

/** Budget for spending `amount` of `mint` (native when it is the native mint) plus fees. */
export function spendBudget(
  mint: string,
  amount: bigint,
  extraNative = 0n,
  receive?: SpendBudget["receive"],
): SpendBudget {
  const base = NATIVE_FEE_ALLOWANCE + extraNative;
  return mint === NATIVE_MINT.toBase58()
    ? { native: base + amount, ...(receive ? { receive } : {}) }
    : { native: base, tokens: new Map([[mint, amount]]), ...(receive ? { receive } : {}) };
}

/** Budget for an action that spends only native value: `amount` plus fees (plus `extra`). */
export function nativeBudget(amount: bigint, extra = 0n): SpendBudget {
  return { native: NATIVE_FEE_ALLOWANCE + extra + amount };
}

/** The least a quote may promise for `totalOut` at `slippageBps`: totalOut × (1 − slippage), floored. */
export function minOutFloor(totalOut: bigint, slippageBps: number): bigint {
  return (totalOut * BigInt(10_000 - slippageBps)) / 10_000n;
}

/**
 * Refuse a quote whose own minimum is below what the requested slippage allows. The guard holds the
 * simulated delivery to the quote's minimum, so a venue that quoted `minOutAmount: 1` would otherwise
 * turn that check into nothing — and the transaction's on-chain floor is the venue's, not ours.
 */
export function assertQuotedMinimum(
  quote: { totalOutAmount: string; minOutAmount: string },
  slippageBps: number,
  source: string,
): bigint {
  const totalOut = BigInt(quote.totalOutAmount);
  const minOut = BigInt(quote.minOutAmount);
  const floor = minOutFloor(totalOut, slippageBps);
  if (minOut < floor) {
    throw new CookieMcpError(
      `refusing this ${source} quote: its minimum output ${minOut} is below the ${floor} that ` +
        `${slippageBps} bps of slippage on ${totalOut} allows`,
      "nothing was signed or sent; retry, and report this if it persists — the quote does not " +
        "respect the slippage it was asked for",
    );
  }
  return minOut;
}

/** An account as both sides of the comparison see it. `null` = does not exist. */
export interface AccountState {
  lamports: bigint;
  /** Owning program, base58. */
  program: string;
  data: Buffer;
}

export interface TokenAccountView {
  mint: string;
  owner: string;
  amount: bigint;
  delegate: string | null;
  closeAuthority: string | null;
}

function coption(data: Buffer, at: number): string | null {
  return data.readUInt32LE(at) === 1
    ? new PublicKey(data.subarray(at + 4, at + 36)).toBase58()
    : null;
}

/** The SPL / Token-2022 account fields this guard compares (pure). Null for anything else. */
export function parseTokenAccount(state: AccountState | null): TokenAccountView | null {
  if (!state) return null;
  const d = state.data;
  // SPL Token accounts are exactly 165 bytes (a mint is 82, a multisig 355). Token-2022 appends
  // extensions after an account-type byte at 165, which is 2 for an account (1 for a mint).
  const isAccount =
    (state.program === TOKEN_PROGRAM && d.length === ACCOUNT_LEN) ||
    (state.program === TOKEN_2022_PROGRAM &&
      (d.length === ACCOUNT_LEN || (d.length > ACCOUNT_LEN && d[ACCOUNT_LEN] === 2)));
  if (!isAccount) return null;
  return {
    mint: new PublicKey(d.subarray(0, 32)).toBase58(),
    owner: new PublicKey(d.subarray(32, 64)).toBase58(),
    amount: d.readBigUInt64LE(64),
    delegate: coption(d, 72),
    closeAuthority: coption(d, 129),
  };
}

/**
 * Compare our accounts before and after (pure). Returns what is wrong with the build, or null.
 * `pre` and `post` hold the same addresses; the wallet is always among them.
 */
export function assessSpend(
  wallet: string,
  pre: ReadonlyMap<string, AccountState | null>,
  post: ReadonlyMap<string, AccountState | null>,
  budget: SpendBudget,
): string | null {
  const native = NATIVE_MINT.toBase58();
  const deltas = new Map<string, bigint>();
  const add = (mint: string, v: bigint) => deltas.set(mint, (deltas.get(mint) ?? 0n) + v);

  const w0 = pre.get(wallet) ?? null;
  const w1 = post.get(wallet) ?? null;
  if (w1 && (w1.program !== SystemProgram.programId.toBase58() || w1.data.length !== 0)) {
    return "it would reassign the wallet account to another program";
  }
  add(native, (w1?.lamports ?? 0n) - (w0?.lamports ?? 0n));

  for (const [address, before] of pre) {
    if (address === wallet) continue;
    const t0 = parseTokenAccount(before);
    const t1 = parseTokenAccount(post.get(address) ?? null);
    const ours0 = t0?.owner === wallet;
    const ours1 = t1?.owner === wallet;
    if (ours0 && t1 && !ours1) {
      return `it would hand our token account ${address} to ${t1.owner}`;
    }
    if (ours1) {
      if (t1.delegate && t1.delegate !== (ours0 ? t0.delegate : null)) {
        return `it would set ${t1.delegate} as a delegate on our token account ${address}`;
      }
      if (t1.closeAuthority && t1.closeAuthority !== (ours0 ? t0.closeAuthority : null)) {
        return `it would give ${t1.closeAuthority} close authority over our token account ${address}`;
      }
      add(t1.mint, t1.amount);
    }
    if (ours0) add(t0.mint, -t0.amount);
  }

  const nativeDelta = deltas.get(native) ?? 0n;
  if (-nativeDelta > budget.native) {
    return `it would take ${-nativeDelta} native base units from the wallet, more than the ${budget.native} this action may spend (amount + fees)`;
  }
  for (const [mint, d] of deltas) {
    if (mint === native || d >= 0n) continue;
    const allowed = budget.tokens?.get(mint) ?? 0n;
    if (-d > allowed) {
      return `it would take ${-d} base units of ${mint} from the wallet, more than the ${allowed} requested`;
    }
  }
  if (budget.receive) {
    const { mint, min } = budget.receive;
    const got = deltas.get(mint) ?? 0n;
    const enough = mint === native ? got + budget.native >= min : got >= min;
    if (!enough) {
      return `it would deliver ${got} base units of ${mint} to the wallet, less than the quoted minimum ${min}`;
    }
  }
  return null;
}

function stateOf(info: AccountInfo<Buffer> | null): AccountState | null {
  if (!info) return null;
  return { lamports: BigInt(info.lamports), program: info.owner.toBase58(), data: info.data };
}

function feePayerOf(tx: Transaction | VersionedTransaction): PublicKey | undefined {
  return tx instanceof VersionedTransaction ? tx.message.staticAccountKeys[0] : tx.feePayer;
}

/** Every writable account + every invoked program, lookup tables resolved from the chain. */
async function accountsOf(
  conn: Connection,
  tx: Transaction | VersionedTransaction,
): Promise<{ writable: PublicKey[]; programs: PublicKey[] }> {
  if (tx instanceof VersionedTransaction) {
    const msg = tx.message as MessageV0;
    const tables: AddressLookupTableAccount[] = [];
    for (const l of msg.addressTableLookups) {
      const t = (await conn.getAddressLookupTable(l.accountKey)).value;
      if (!t) throw new Error(`lookup table ${l.accountKey.toBase58()} not found`);
      tables.push(t);
    }
    const keys = msg.getAccountKeys({ addressLookupTableAccounts: tables });
    const writable: PublicKey[] = [];
    for (let i = 0; i < keys.length; i++) if (msg.isAccountWritable(i)) writable.push(keys.get(i)!);
    const programs = msg.compiledInstructions.map((ix) => keys.get(ix.programIdIndex)!);
    return { writable, programs };
  }
  const msg = tx.compileMessage();
  const writable = msg.accountKeys.filter((_, i) => msg.isAccountWritable(i));
  return { writable, programs: tx.instructions.map((ix) => ix.programId) };
}

/**
 * Simulate an API-built transaction and hold it to `budget` (see the file comment). Returns the
 * simulation so the caller keeps its own error mapping for a failed one; throws a `CookieMcpError`
 * when the build succeeds but does something to our wallet it should not.
 */
export async function simulateWithinBudget(
  conn: Connection,
  tx: Transaction | VersionedTransaction,
  owner: PublicKey,
  budget: SpendBudget,
  opts: { what: string; source: string; commitment?: Commitment; replaceRecentBlockhash?: boolean },
): Promise<{ value: SimulatedTransactionResponse }> {
  const refuse = (detail: string) =>
    new CookieMcpError(
      `refusing to sign this ${opts.what}: the ${opts.source} build does not match the request (${detail})`,
      "nothing was signed or sent; retry, and report this if it persists — it can mean the API is " +
        "misbehaving or something between you and it is tampering with the transaction",
    );

  const payer = feePayerOf(tx);
  if (!payer?.equals(owner)) {
    throw refuse(`fee payer is ${payer?.toBase58() ?? "missing"}, not this wallet`);
  }
  let accounts: Awaited<ReturnType<typeof accountsOf>>;
  try {
    accounts = await accountsOf(conn, tx);
  } catch (e) {
    throw refuse(e instanceof Error ? e.message : String(e));
  }
  for (const p of accounts.programs) {
    const name = FORBIDDEN_PROGRAMS.get(p.toBase58());
    if (name) throw refuse(`it invokes ${name}`);
  }

  // The wallet first, then each writable account once. ATA program accounts are never ours.
  const seen = new Set<string>([owner.toBase58()]);
  const keys = [owner];
  for (const k of accounts.writable) {
    const b58 = k.toBase58();
    if (seen.has(b58) || k.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) continue;
    seen.add(b58);
    keys.push(k);
  }

  const pre = new Map<string, AccountState | null>();
  for (let i = 0; i < keys.length; i += 100) {
    const chunk = keys.slice(i, i + 100);
    const infos = await conn.getMultipleAccountsInfo(chunk, opts.commitment ?? "confirmed");
    chunk.forEach((k, j) => pre.set(k.toBase58(), stateOf(infos[j] ?? null)));
  }

  // A program the build calls could reach stake / vote / loader accounts by CPI with our signature;
  // the owner of each written account shows that where the top-level program list does not.
  for (const [address, state] of pre) {
    const name = state && FORBIDDEN_PROGRAMS.get(state.program);
    if (name && address !== owner.toBase58()) {
      throw refuse(`it writes to ${address}, an account owned by ${name}`);
    }
  }

  // One simulation path for both wire formats: a legacy build is compiled to its message (which
  // `accountsOf` already required) so the commitment and the account request apply to it too. The
  // legacy overload takes neither, and simulates at the connection's default commitment, which could
  // differ from the pre-state read above.
  const simTx =
    tx instanceof VersionedTransaction ? tx : new VersionedTransaction(tx.compileMessage());
  const sim = await conn.simulateTransaction(simTx, {
    replaceRecentBlockhash: opts.replaceRecentBlockhash ?? true,
    sigVerify: false,
    ...(opts.commitment ? { commitment: opts.commitment } : {}),
    accounts: { encoding: "base64", addresses: keys.map((k) => k.toBase58()) },
  });
  if (sim.value.err) return sim;

  const returned = sim.value.accounts;
  if (!returned || returned.length !== keys.length) {
    throw refuse("the RPC did not return the simulated account state, so the effect is unknown");
  }
  const post = new Map<string, AccountState | null>();
  keys.forEach((k, i) => {
    const a = returned[i];
    post.set(
      k.toBase58(),
      a
        ? {
            lamports: BigInt(a.lamports),
            program: a.owner,
            data: Buffer.from(a.data[0] ?? "", "base64"),
          }
        : null,
    );
  });

  const problem = assessSpend(owner.toBase58(), pre, post, budget);
  if (problem) throw refuse(problem);
  return sim;
}
