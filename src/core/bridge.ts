// bridge — move a token 1:1 between Cookie Chain and Solana mainnet over Hyperlane warp routes.
//
// This is a self-contained port of hyperlane-cookies/backend/lib/hyperlaneSealevel.ts (the same
// transfer-remote flow the Hyperlane SDK uses, reimplemented without the SDK runtime). Which tokens
// exist, and each side's route type (native / synthetic / collateral), mint, decimals and IGP, are read
// from the chain by bridgeRoutes.ts — so a route added after this release works without a change here.
// The instruction data is hand-encoded (no borsh dep) — the layout is fixed:
// [8-byte discriminator][u8 instruction=1][u32 dest domain LE][32-byte recipient][u256 amount LE].
//
// Flow: build the transfer-remote tx → partial-sign the ephemeral "unique message" signer (replay
// protection, per Hyperlane) → add the wallet signature → simulate → send + confirm on the SOURCE
// chain → extract the Hyperlane message id from logs. A relayer then delivers on the far side in a few
// minutes; delivery is verifiable via the destination mailbox's processed_message PDA.
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  type AccountMeta,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

import { BRIDGE, COOKIE_DOMAIN, SOLANA_DOMAIN, explorerTxUrl, solanaExplorerTxUrl } from "./config";
import {
  deriveAtaPayerPda,
  deriveEscrowPda,
  deriveNativeCollateralPda,
  deriveTokenPda,
  NATIVE_SYMBOL,
  resolveBridgeToken,
  type BridgeChain,
  type BridgeRoute,
  type IgpConfig,
  type RouteSide,
} from "./bridgeRoutes";
import { MIN_BRIDGE_COOK, MINIMUM_BASIS_LABEL, getBridgeMinimum } from "./bridgeMinimum";
import { confirmSent } from "./confirm";
import { CookieMcpError } from "./errors";
import { getConnection, getSolanaConnection } from "./rpc";
import { requireSigner, ownPublicKey } from "./wallet";
import { signWithCosigners, type TxSigner } from "./signer";
import { rawToUi, uiToRaw } from "./format";

// Standard Solana SPL no-op program used by Hyperlane for log emission.
const SPL_NOOP_PROGRAM_ID = new PublicKey("noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV");
const DISCRIMINATOR = Buffer.from([1, 1, 1, 1, 1, 1, 1, 1]);
const TRANSFER_REMOTE_INSTRUCTION = 1;
const COMPUTE_LIMIT = 1_000_000;
const SEP = "-";

export type BridgeDirection = "cookie-to-solana" | "solana-to-cookie";

// --- Instruction encoding (fixed layout, hand-rolled to avoid a borsh dependency) ---------------

/** Encode transfer-remote ix data: disc(8) + instruction u8 + destDomain u32 LE + recipient[32] +
 *  amount u256 LE. Byte-for-byte equal to the borsh-serialized form the Rust warp processor expects. */
export function encodeTransferRemoteIxData(
  destinationDomain: number,
  recipient32: Uint8Array,
  amount: bigint,
): Buffer {
  if (recipient32.length !== 32) {
    throw new Error(`recipient must be 32 bytes, got ${recipient32.length}`);
  }
  const buf = Buffer.alloc(8 + 1 + 4 + 32 + 32);
  DISCRIMINATOR.copy(buf, 0);
  buf.writeUInt8(TRANSFER_REMOTE_INSTRUCTION, 8);
  buf.writeUInt32LE(destinationDomain, 9);
  Buffer.from(recipient32).copy(buf, 13);
  let a = amount;
  for (let i = 0; i < 32; i++) {
    buf[45 + i] = Number(a & 0xffn);
    a >>= 8n;
  }
  if (a !== 0n) throw new Error("amount exceeds u256");
  return buf;
}

/** Convert a base58 (Sealevel) or 0x-hex recipient into a 32-byte buffer. */
export function recipientTo32(recipient: string): Uint8Array {
  if (recipient.startsWith("0x")) {
    const hex = recipient.slice(2);
    if (hex.length !== 64) {
      throw new Error(`hex recipient must be 32 bytes (64 hex chars), got ${hex.length}`);
    }
    return Buffer.from(hex, "hex");
  }
  return new PublicKey(recipient).toBytes();
}

// --- PDA derivation (seeds joined by a literal '-', per the Hyperlane sealevel programs) ---------

function pda(seeds: Array<string | Buffer>, programId: PublicKey): PublicKey {
  const seedBuffers = seeds.map((s) => (typeof s === "string" ? Buffer.from(s) : s));
  return PublicKey.findProgramAddressSync(seedBuffers, programId)[0];
}

const deriveMailboxOutbox = (mailbox: PublicKey) => pda(["hyperlane", SEP, "outbox"], mailbox);
const deriveDispatchAuthority = (warp: PublicKey) =>
  pda(["hyperlane_dispatcher", SEP, "dispatch_authority"], warp);
const deriveDispatchedMessage = (mailbox: PublicKey, uniqueMsg: PublicKey) =>
  pda(["hyperlane", SEP, "dispatched_message", SEP, uniqueMsg.toBuffer()], mailbox);
// Re-exported so existing importers (and the golden-PDA tests) keep one import path.
export { deriveAtaPayerPda, deriveEscrowPda, deriveNativeCollateralPda };
const deriveIgpProgramData = (igpProgramId: PublicKey) =>
  pda(["hyperlane_igp", SEP, "program_data"], igpProgramId);
const deriveGasPayment = (igpProgramId: PublicKey, uniqueMsg: PublicKey) =>
  pda(["hyperlane_igp", SEP, "gas_payment", SEP, uniqueMsg.toBuffer()], igpProgramId);
const deriveProcessedMessage = (mailbox: PublicKey, idBytes: Buffer) =>
  pda(["hyperlane", SEP, "processed_message", SEP, idBytes], mailbox);

/**
 * Read the inner IGP pubkey from an OverheadIgpAccount's data. Layout (verified on-chain):
 *   initialized u8(1) · discriminator [8] · bump u8(1) · salt H256(32) · owner Option<Pubkey>(1+0|32)
 *   · inner Pubkey(32) ← what we want · gas_overheads HashMap.
 */
async function readOverheadIgpInner(
  conn: Connection,
  overheadIgpAccount: PublicKey,
): Promise<PublicKey> {
  const info = await conn.getAccountInfo(overheadIgpAccount, "confirmed");
  if (!info) {
    throw new CookieMcpError(
      `Hyperlane OverheadIgp account not found: ${overheadIgpAccount.toBase58()}`,
      "the route's token account names an IGP that isn't on this chain — check the RPC points at the right network",
    );
  }
  const buf = info.data;
  let off = 42; // initialized(1) + discriminator(8) + bump(1) + salt(32)
  const ownerTag = buf.readUInt8(off);
  off += 1;
  if (ownerTag === 1) off += 32;
  const innerBytes = buf.subarray(off, off + 32);
  if (innerBytes.length !== 32) {
    throw new CookieMcpError(
      `failed to read inner IGP pubkey from ${overheadIgpAccount.toBase58()}`,
      "the OverheadIgp account layout was unexpected",
    );
  }
  return new PublicKey(innerBytes);
}

/** Parse the Hyperlane dispatch message id (0x…64 hex) from confirmed tx logs. */
export function messageIdFromLogs(logs: string[] | null | undefined): string | null {
  if (!logs?.length) return null;
  for (const line of logs) {
    const m = line.match(/ID (0x[a-fA-F0-9]{64})/i);
    if (m) return m[1].toLowerCase();
  }
  for (const line of logs) {
    const m = line.match(/(0x[a-fA-F0-9]{64})/);
    if (m) return m[1].toLowerCase();
  }
  return null;
}

// --- Route wiring ------------------------------------------------------------------------------

const CHAIN_NAME: Record<BridgeChain, string> = { cookie: "Cookie Chain", solana: "Solana" };

/** One direction of a token's route. Exported with routeFor/buildTransferRemoteIx for
 *  scripts/verify-bridge.ts, which simulates real transfers without signing. */
export interface Route {
  symbol: string;
  source: RouteSide;
  dest: RouteSide;
  sourceConn: Connection;
  destConn: Connection;
  destinationDomain: number;
  sourceExplorerTxUrl: (sig: string) => string;
}

export function routeFor(token: BridgeRoute, direction: BridgeDirection): Route {
  const toSolana = direction === "cookie-to-solana";
  return {
    symbol: token.symbol,
    source: toSolana ? token.cookie : token.solana,
    dest: toSolana ? token.solana : token.cookie,
    sourceConn: toSolana ? getConnection() : getSolanaConnection(),
    destConn: toSolana ? getSolanaConnection() : getConnection(),
    destinationDomain: toSolana ? SOLANA_DOMAIN : COOKIE_DOMAIN,
    sourceExplorerTxUrl: toSolana ? explorerTxUrl : solanaExplorerTxUrl,
  };
}

// --- Instruction builder -----------------------------------------------------------------------

/**
 * The plugin-specific accounts appended after the shared transfer_remote accounts. Order and
 * writability must match the Sealevel token plugin exactly:
 *   native     → system program, native_collateral PDA (w)
 *   synthetic  → Token-2022 program, mint PDA (w), sender ATA (w)
 *   collateral → token program, mint (w), sender ATA (w), escrow PDA (w)
 */
export function pluginAccountMetas(side: RouteSide, sender: PublicKey): AccountMeta[] {
  if (side.type === "native") {
    return [
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: deriveNativeCollateralPda(side.warp), isSigner: false, isWritable: true },
    ];
  }
  const mint = side.mint!;
  const tokenProgram = side.tokenProgram!;
  const senderAta = getAssociatedTokenAddressSync(mint, sender, true, tokenProgram);
  const metas: AccountMeta[] = [
    { pubkey: tokenProgram, isSigner: false, isWritable: false },
    { pubkey: mint, isSigner: false, isWritable: true },
    { pubkey: senderAta, isSigner: false, isWritable: true },
  ];
  if (side.type === "collateral") {
    metas.push({ pubkey: deriveEscrowPda(side.warp), isSigner: false, isWritable: true });
  }
  return metas;
}

/** Accounts 9–13: the IGP the route is configured with. A plain IGP takes its account directly; an
 *  overhead IGP takes the overhead account followed by the inner IGP it wraps; no IGP, no accounts. */
export function igpAccountMetas(
  igp: IgpConfig | null,
  uniqueMsg: PublicKey,
  innerIgp: PublicKey | null,
): AccountMeta[] {
  if (!igp) return [];
  const metas: AccountMeta[] = [
    { pubkey: igp.program, isSigner: false, isWritable: false }, // 9 IGP program
    { pubkey: deriveIgpProgramData(igp.program), isSigner: false, isWritable: true }, // 10 (w)
    { pubkey: deriveGasPayment(igp.program, uniqueMsg), isSigner: false, isWritable: true }, // 11 (w)
  ];
  if (igp.kind === "overheadIgp") {
    metas.push({ pubkey: igp.account, isSigner: false, isWritable: false }); // 12 overhead IGP
    metas.push({ pubkey: innerIgp!, isSigner: false, isWritable: true }); // 13 inner IGP (w)
  } else {
    metas.push({ pubkey: igp.account, isSigner: false, isWritable: true }); // 12 IGP (w)
  }
  return metas;
}

export async function buildTransferRemoteIx(
  route: Route,
  sender: PublicKey,
  uniqueMsg: PublicKey,
  recipient32: Uint8Array,
  amount: bigint,
): Promise<TransactionInstruction> {
  const { warp, mailbox, igp } = route.source;
  const innerIgp =
    igp?.kind === "overheadIgp" ? await readOverheadIgpInner(route.sourceConn, igp.account) : null;

  const keys: AccountMeta[] = [
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // 0 system
    { pubkey: SPL_NOOP_PROGRAM_ID, isSigner: false, isWritable: false }, // 1 spl_noop
    { pubkey: deriveTokenPda(warp), isSigner: false, isWritable: false }, // 2 token PDA
    { pubkey: mailbox, isSigner: false, isWritable: false }, // 3 mailbox program
    { pubkey: deriveMailboxOutbox(mailbox), isSigner: false, isWritable: true }, // 4 outbox (w)
    { pubkey: deriveDispatchAuthority(warp), isSigner: false, isWritable: false }, // 5 dispatch auth
    { pubkey: sender, isSigner: true, isWritable: false }, // 6 sender (signer)
    { pubkey: uniqueMsg, isSigner: true, isWritable: false }, // 7 unique message signer
    { pubkey: deriveDispatchedMessage(mailbox, uniqueMsg), isSigner: false, isWritable: true }, // 8 (w)
    ...igpAccountMetas(igp, uniqueMsg, innerIgp), // 9–13
    ...pluginAccountMetas(route.source, sender),
  ];

  return new TransactionInstruction({
    keys,
    programId: warp,
    data: encodeTransferRemoteIxData(route.destinationDomain, recipient32, amount),
  });
}

// --- Destination collateral preflight ----------------------------------------------------------
// A native or collateral destination RELEASES the transfer from a fixed account (the native-collateral
// PDA, or the escrow). If that account is short, the source tx still succeeds — it takes your funds
// and dispatches the message — and only the relayer's delivery on the far side fails.
// simulateTransaction runs against the SOURCE chain, so it can never catch this. Hence an explicit
// read of the destination before signing. A synthetic destination mints, so it has no such limit.
//
// The two kinds need DIFFERENT reads: the native PDA holds lamports, while the escrow IS the token
// account itself, not a wallet owning an ATA — an owner-based ATA lookup finds nothing there and
// would report 0.

/** Rescale a raw amount between the two sides' decimals (COOK: Cookie 9, Solana 6). Scaling down
 *  truncates, which can only UNDERstate the requirement by sub-dust — never overstate it into a false
 *  failure. */
export function scaleRaw(raw: bigint, fromDecimals: number, toDecimals: number): bigint {
  if (toDecimals === fromDecimals) return raw;
  const diff = BigInt(Math.abs(toDecimals - fromDecimals));
  const factor = 10n ** diff;
  return toDecimals > fromDecimals ? raw * factor : raw / factor;
}

/** Available collateral in the destination's raw units, or null when it can't be determined
 *  (unreadable account, RPC failure) — an unknown is reported, never treated as zero. */
async function readDestinationCollateral(route: Route): Promise<bigint | null> {
  const { dest, destConn } = route;
  try {
    if (dest.type === "collateral") {
      const bal = await destConn.getTokenAccountBalance(deriveEscrowPda(dest.warp), "confirmed");
      return BigInt(bal.value.amount);
    }
    // Native side: the PDA carries account data, so its rent-exempt reserve is NOT releasable.
    // Subtract it rather than counting it as available collateral.
    const info = await destConn.getAccountInfo(deriveNativeCollateralPda(dest.warp), "confirmed");
    if (!info) return null;
    const rent = await destConn.getMinimumBalanceForRentExemption(info.data.length);
    const free = BigInt(info.lamports) - BigInt(rent);
    return free > 0n ? free : 0n;
  } catch {
    return null;
  }
}

/** Throws when the destination provably cannot cover the release. Returns the collateral as a UI
 *  amount for the result, or null when the destination mints (synthetic) or couldn't be read. */
async function assertDestinationCollateral(
  route: Route,
  amountRaw: bigint,
): Promise<string | null> {
  if (route.dest.type === "synthetic") return null;
  const available = await readDestinationCollateral(route);
  if (available === null) return null;
  const decimals = route.dest.decimals;
  const needed = scaleRaw(amountRaw, route.source.decimals, decimals);
  if (available < needed) {
    throw new CookieMcpError(
      `not enough bridge collateral on ${CHAIN_NAME[route.dest.chain]}: the route can release ` +
        `${rawToUi(available, decimals)} ${route.symbol} but this transfer needs ` +
        `${rawToUi(needed, decimals)}`,
      "nothing was signed. The warp route releases from a fixed collateral account, so a larger " +
        "transfer than it holds would lock your funds on this side with an undeliverable message — " +
        "bridge a smaller amount, or wait for the route's collateral to be topped up",
    );
  }
  return rawToUi(available, decimals);
}

// --- Native payout to a new wallet -------------------------------------------------------------
// A native destination pays out with a plain System transfer into the recipient. If the recipient
// wallet doesn't exist yet and the payout is below the rent-exempt minimum for an empty account,
// the runtime rejects that transfer — on every relayer retry, forever — after the source side has
// already taken the funds. Nothing on the source chain can see it, so refuse it here.

/** True when paying `payout` lamports into a wallet holding `recipientLamports` would be refused for
 *  leaving it below rent. An existing wallet is already rent-exempt, so only an empty one matters. */
export function nativePayoutBelowRent(args: {
  recipientLamports: bigint;
  payout: bigint;
  rentExemptMinimum: bigint;
}): boolean {
  return args.recipientLamports === 0n && args.payout < args.rentExemptMinimum;
}

async function assertNativePayoutRentSafe(
  route: Route,
  recipient: PublicKey,
  amountRaw: bigint,
): Promise<void> {
  if (route.dest.type !== "native") return;
  const conn = route.destConn;
  let recipientLamports: bigint;
  let rentExemptMinimum: bigint;
  try {
    [recipientLamports, rentExemptMinimum] = await Promise.all([
      conn.getBalance(recipient, "confirmed").then(BigInt),
      conn.getMinimumBalanceForRentExemption(0).then(BigInt),
    ]);
  } catch {
    return; // unreadable — proceed as before this check existed
  }
  const payout = scaleRaw(amountRaw, route.source.decimals, route.dest.decimals);
  if (nativePayoutBelowRent({ recipientLamports, payout, rentExemptMinimum })) {
    const sym = NATIVE_SYMBOL[route.dest.chain];
    throw new CookieMcpError(
      `the recipient holds no ${sym} on ${CHAIN_NAME[route.dest.chain]} and ` +
        `${rawToUi(payout, route.dest.decimals)} ${sym} is below the ` +
        `${rawToUi(rentExemptMinimum, route.dest.decimals)} ${sym} a new wallet must start with`,
      "nothing was signed. The delivery would be rejected for leaving the new wallet below rent, " +
        "on every retry, after this side had already taken your funds. Bridge at least " +
        `${rawToUi(rentExemptMinimum, route.dest.decimals)} ${sym}, or send to a wallet that already ` +
        `holds ${sym}.`,
    );
  }
}

// --- Recipient token account (synthetic / collateral destinations) -----------------------------
// A token delivery credits ATA(recipient, mint). If that account doesn't exist yet, the warp program
// creates it and pays the rent from its `ata_payer` PDA. That PDA is funded ONCE at deploy time
// (0.05 SOL by default — about 24 accounts) and is never topped up automatically, so it runs dry. When
// it can no longer cover one account's rent, delivery to any NEW recipient fails inside the relayer —
// and because the relayer simulates before submitting, nothing lands on chain, nothing errors, and the
// transfer just hangs. Observed 2026-08-26 on a UI bridge; it only moved after someone created the
// recipient's token account by hand. Neither the source-chain simulation nor the collateral preflight
// above can see it (the escrow was full — it was SOL for rent that was missing, not COOK).
//
// So don't depend on that PDA: when the recipient has no token account, create it ourselves first,
// from this wallet, on the destination chain, and confirm it BEFORE dispatching. That is one extra
// account rent in the destination's native coin (the recipient can reclaim it by closing the account)
// in exchange for removing a shared, silently-drainable dependency from the path. It runs first
// precisely so that a failure here costs nothing: nothing is locked on the source chain yet.

const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
/** Token-2022 associated accounts carry the ImmutableOwner extension: the 165-byte classic layout plus
 *  a 1-byte account type and a 4-byte extension header — 170 bytes, more rent than a classic ATA. */
const ATA_LEN_CLASSIC = 165;
const ATA_LEN_TOKEN_2022 = 170;
/** Left spare for the creation tx's own fee (a signature is 5000 lamports; keep room for a retry). */
const ATA_CREATE_FEE_BUFFER = 15_000n;

/** Lamports the funder is SHORT of creating one token account, or 0n when it can afford it.
 *  `reserve` is whatever must stay behind: for the route's ata_payer that's its own rent-exempt minimum
 *  (a system account with no data still has one, and a transfer dipping below it fails); for our wallet
 *  it's the fee headroom. Either way the reserve is subtracted, never counted as available. */
export function ataPayerShortfall(args: {
  payerLamports: bigint;
  payerRentReserve: bigint;
  ataRent: bigint;
}): bigint {
  const spendable = args.payerLamports - args.payerRentReserve;
  const short = args.ataRent - (spendable > 0n ? spendable : 0n);
  return short > 0n ? short : 0n;
}

export interface RecipientTokenAccountInfo {
  /** The recipient's associated token account for the bridged token on the destination chain. */
  address: string;
  /** Whether it already existed when the bridge started. */
  exists: boolean;
  /** Signature of the account-creation tx this bridge sent first, or null when none was needed. */
  createdSignature: string | null;
  /** Whether the route's own ATA payer could have covered it. Informational — null when not checked. */
  routePayerCanFund: boolean | null;
}

interface RecipientAtaRead {
  ata: PublicKey;
  exists: boolean;
  ataRent: bigint;
  /** What the route's ata_payer is short by; 0n when it can pay, null when not checked. */
  routePayerShortfall: bigint | null;
}

/** Reads the far side, or null when any part of it is unreadable (RPC failure) — an unknown is
 *  reported as unchecked and the bridge proceeds as it did before this check existed. */
async function readRecipientAta(
  route: Route,
  recipient: PublicKey,
): Promise<RecipientAtaRead | null> {
  const { dest, destConn: conn } = route;
  if (dest.type === "native") return null; // paid into the wallet itself: no account to create
  try {
    const ata = getAssociatedTokenAddressSync(dest.mint!, recipient, true, dest.tokenProgram!);
    const ataInfo = await conn.getAccountInfo(ata, "confirmed");
    if (ataInfo) return { ata, exists: true, ataRent: 0n, routePayerShortfall: null };

    const ataLen = dest.tokenProgram!.equals(TOKEN_2022_PROGRAM_ID)
      ? ATA_LEN_TOKEN_2022
      : ATA_LEN_CLASSIC;
    const ataRent = BigInt(await conn.getMinimumBalanceForRentExemption(ataLen));
    const [payer, payerReserve] = await Promise.all([
      conn.getAccountInfo(deriveAtaPayerPda(dest.warp), "confirmed"),
      conn.getMinimumBalanceForRentExemption(0),
    ]);
    const routePayerShortfall = ataPayerShortfall({
      payerLamports: BigInt(payer?.lamports ?? 0),
      payerRentReserve: BigInt(payerReserve),
      ataRent,
    });
    return { ata, exists: false, ataRent, routePayerShortfall };
  } catch {
    return null;
  }
}

/** Creates the recipient's token account on the destination if they don't have one, paid by this
 *  wallet, and confirms it before the caller dispatches anything. Returns null when not applicable or
 *  the check couldn't run. Throws only when the account is missing AND cannot be created — in which
 *  case nothing was signed on the source chain, so the bridge is simply refused. */
async function ensureRecipientTokenAccount(
  route: Route,
  recipient: PublicKey,
  signer: TxSigner,
  opts: { create: boolean },
): Promise<RecipientTokenAccountInfo | null> {
  const read = await readRecipientAta(route, recipient);
  if (!read) return null;
  const routePayerCanFund =
    read.routePayerShortfall === null ? null : read.routePayerShortfall === 0n;
  if (read.exists) {
    return {
      address: read.ata.toBase58(),
      exists: true,
      createdSignature: null,
      routePayerCanFund,
    };
  }

  const base = { address: read.ata.toBase58(), exists: false, routePayerCanFund };
  const { dest, symbol } = route;
  const chain = CHAIN_NAME[dest.chain];
  const native = NATIVE_SYMBOL[dest.chain];

  // Opted out of creating it: fall back to leaning on the route's payer, and refuse if it's dry.
  if (!opts.create) {
    if (routePayerCanFund === false) {
      throw new CookieMcpError(
        `the recipient has no ${symbol} account on ${chain} and the bridge route cannot pay to ` +
          `create one: its ATA payer ${deriveAtaPayerPda(dest.warp).toBase58()} is short ` +
          `${rawToUi(read.routePayerShortfall!, 9)} ${native} of the ${rawToUi(read.ataRent, 9)} ` +
          `${native} rent`,
        "nothing was signed. The relayer's delivery would fail in simulation and never reach the " +
          `chain, so the source transfer would take your ${symbol} and hang with no error anywhere. ` +
          "Drop createRecipientAccount:false to let this wallet create the account instead (it needs " +
          `the rent in ${native} on ${chain}), or have the payer PDA topped up.`,
      );
    }
    return { ...base, createdSignature: null };
  }

  const conn = route.destConn;
  const balance = BigInt(await conn.getBalance(signer.publicKey, "confirmed"));
  const shortfall = ataPayerShortfall({
    payerLamports: balance,
    payerRentReserve: ATA_CREATE_FEE_BUFFER,
    ataRent: read.ataRent,
  });
  if (shortfall > 0n) {
    throw new CookieMcpError(
      `the recipient has no ${symbol} account on ${chain} and this wallet is ` +
        `${rawToUi(shortfall, 9)} ${native} short of creating one (needs ${rawToUi(read.ataRent, 9)} ` +
        `${native} of rent plus fees, holds ${rawToUi(balance, 9)} ${native} on ${chain})`,
      `nothing was signed. A delivery to ${chain} has to credit a token account, and the recipient ` +
        `doesn't have one — bridging before it exists risks a transfer that takes your ${symbol} and ` +
        `hangs undelivered. Fund this wallet with a little ${native} on ${chain}, or bridge to an ` +
        `address that already holds ${symbol} there.`,
    );
  }

  // Idempotent: harmless if the relayer, the recipient, or a concurrent bridge wins the race.
  const createIx = createAssociatedTokenAccountIdempotentInstruction(
    signer.publicKey,
    read.ata,
    recipient,
    dest.mint!,
    dest.tokenProgram!,
  );
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: signer.publicKey, blockhash, lastValidBlockHeight }).add(
    createIx,
  );
  const toCookie = dest.chain === "cookie";
  const explorerUrl = toCookie ? explorerTxUrl : solanaExplorerTxUrl;
  await signer.signTransaction(tx, {
    what: "recipient-account",
    blockhash,
    lastValidBlockHeight,
    submit: { via: toCookie ? "cookie-rpc" : "solana-rpc" },
    step: "intermediate",
    summary: {
      creates: `the recipient's ${symbol} token account on ${chain}`,
      recipient: recipient.toBase58(),
      tokenAccount: read.ata.toBase58(),
    },
  });
  const signature = await conn.sendRawTransaction(tx.serialize());
  // Confirm before the caller dispatches: the bridge must not go out against an unconfirmed account.
  await confirmSent(conn, { signature, blockhash, lastValidBlockHeight }, "recipient-account", {
    explorerUrl: explorerUrl(signature),
  });
  return { ...base, createdSignature: signature };
}

// --- Delivery check ----------------------------------------------------------------------------

async function isDelivered(
  conn: Connection,
  destMailbox: PublicKey,
  messageIdHex: string,
): Promise<{ delivered: boolean; destinationTx: string | null }> {
  const id = messageIdHex.startsWith("0x") ? messageIdHex.slice(2) : messageIdHex;
  if (id.length !== 64) return { delivered: false, destinationTx: null };
  const idBytes = Buffer.from(id, "hex");
  const processedPda = deriveProcessedMessage(destMailbox, idBytes);
  const info = await conn.getAccountInfo(processedPda, "confirmed");
  if (!info) return { delivered: false, destinationTx: null };
  // Finding the delivery tx is a nicety; some paid RPC plans refuse this index method, and that must
  // not turn a delivered transfer into an error.
  const sigs = await conn.getSignaturesForAddress(processedPda, { limit: 1 }).catch(() => []);
  return { delivered: true, destinationTx: sigs[0]?.signature ?? null };
}

// --- Public API --------------------------------------------------------------------------------

export interface BridgeResult {
  direction: BridgeDirection;
  /** The bridged token, with its mint on each side (null = that chain's native coin). */
  token: { symbol: string; sourceMint: string | null; destinationMint: string | null };
  from: string;
  to: string;
  amount: string;
  sourceSignature: string;
  sourceExplorerUrl: string;
  messageId: string | null;
  destinationDomain: number;
  delivered: boolean;
  destinationTx: string | null;
  /** Collateral available on the destination when the transfer was signed (UI amount of the token);
   *  null when the destination mints the token on delivery (no limit) or it could not be read. */
  destinationCollateral: string | null;
  /** Token destinations: the recipient's token account, and the tx that created it when this bridge
   *  had to. null when the destination pays the native coin, or it could not be read. */
  recipientTokenAccount: RecipientTokenAccountInfo | null;
  /** The minimum this transfer was checked against (UI amount of the token, worth MIN_BRIDGE_COOK
   *  COOK), or null when no price was available and the minimum was skipped. */
  minimum: { amount: string; worthCook: number; basis: string } | null;
  note: string;
}

export async function bridge(args: {
  /** Symbol or mint (either chain) of the token to bridge; defaults to COOK. */
  token?: string;
  direction: BridgeDirection;
  to?: string;
  amount: string | number;
  waitForDelivery?: boolean;
  /** Token destinations: create the recipient's token account from this wallet when they have none
   *  (default). Set false to rely on the warp route's own ATA payer instead — which is refused when
   *  that payer is provably dry, since the transfer would hang. */
  createRecipientAccount?: boolean;
}): Promise<BridgeResult> {
  if (args.direction !== "cookie-to-solana" && args.direction !== "solana-to-cookie") {
    throw new CookieMcpError(
      `invalid direction "${args.direction}"`,
      "use 'cookie-to-solana' or 'solana-to-cookie'",
    );
  }
  const signer = requireSigner();
  const sender = signer.publicKey;
  const token = await resolveBridgeToken(args.token ?? "COOK");
  const route = routeFor(token, args.direction);
  const { source, dest } = route;

  // Recipient on the destination chain. Both chains are SVM and use the same keypair, so default to
  // bridging to your own wallet on the other side.
  const to = args.to ?? ownPublicKey()!;
  let recipient32: Uint8Array;
  try {
    recipient32 = recipientTo32(to);
  } catch {
    throw new CookieMcpError(
      `invalid recipient: ${to}`,
      "pass the destination-chain recipient as a base58 pubkey",
    );
  }

  let amountRaw: bigint;
  try {
    amountRaw = uiToRaw(args.amount, source.decimals);
  } catch {
    throw new CookieMcpError(
      `invalid amount "${args.amount}"`,
      `${token.symbol} has ${source.decimals} decimals on ${CHAIN_NAME[source.chain]}`,
    );
  }
  if (amountRaw <= 0n) {
    throw new CookieMcpError("amount must be greater than 0", "pass a positive amount");
  }

  // Refuse dust before any preflight or signature, so a rejected call costs nothing.
  const min = await getBridgeMinimum(token);
  const minimum = min
    ? {
        amount: rawToUi(scaleRaw(min.raw, min.decimals, source.decimals), source.decimals),
        worthCook: MIN_BRIDGE_COOK,
        basis: min.basis,
      }
    : null;
  if (min) {
    const minSource = scaleRaw(min.raw, min.decimals, source.decimals);
    if (amountRaw < minSource) {
      throw new CookieMcpError(
        `${args.amount} ${token.symbol} is below the bridge minimum of ` +
          `${rawToUi(minSource, source.decimals)} ${token.symbol}`,
        `the minimum is whatever is worth ${MIN_BRIDGE_COOK.toLocaleString("en-US")} COOK ` +
          `(${MINIMUM_BASIS_LABEL[min.basis]}). Relay cost is per message, so a smaller transfer ` +
          `costs more in fees than it moves. Nothing was signed — bridge at least ` +
          `${rawToUi(minSource, source.decimals)} ${token.symbol}.`,
      );
    }
  }

  // Preflight the far side's collateral before anything is signed (see the section above).
  const destinationCollateral = await assertDestinationCollateral(route, amountRaw);
  // Make sure a first-time recipient can actually receive (see above). Both run before the dispatch,
  // so a failure here leaves nothing locked.
  await assertNativePayoutRentSafe(route, new PublicKey(recipient32), amountRaw);
  const recipientTokenAccount = await ensureRecipientTokenAccount(
    route,
    new PublicKey(recipient32),
    signer,
    { create: args.createRecipientAccount !== false },
  );

  const uniqueMsg = Keypair.generate();
  const transferIx = await buildTransferRemoteIx(
    route,
    sender,
    uniqueMsg.publicKey,
    recipient32,
    amountRaw,
  );
  const computeIx = ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_LIMIT });

  const { blockhash, lastValidBlockHeight } =
    await route.sourceConn.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: sender, blockhash, lastValidBlockHeight })
    .add(computeIx)
    .add(transferIx);

  // Simulate defensively: the Cookie Chain Agave fork can reject the rich simulate call even for a
  // valid tx (a known fork quirk), so a *thrown* simulation is treated as "couldn't simulate" and we
  // proceed. A simulation that actually runs and returns an error is surfaced.
  try {
    const sim = await route.sourceConn.simulateTransaction(tx);
    if (sim.value.err) {
      const logs = sim.value.logs ?? [];
      const blob = `${JSON.stringify(sim.value.err)} ${logs.join(" ")}`;
      if (/BlockhashNotFound|blockhash/i.test(blob) && source.chain === "cookie") {
        throw new CookieMcpError(
          "bridge simulation failed: blockhash not found",
          "Cookie Chain finalization may be stalled — check chain_health; retry shortly",
        );
      }
      throw new CookieMcpError(
        `bridge simulation failed${logs.length ? `: ${logs.slice(-3).join(" | ")}` : ""}`,
        source.type === "native"
          ? `check the wallet's ${token.symbol} balance on ${CHAIN_NAME[source.chain]} ` +
              "(amount + fees + interchain-gas payment)"
          : `check the wallet's ${token.symbol} balance on ${CHAIN_NAME[source.chain]} and that it ` +
              `holds ${NATIVE_SYMBOL[source.chain]} for fees and interchain gas`,
      );
    }
  } catch (e) {
    if (e instanceof CookieMcpError) throw e;
    // Fork rejected the simulate call itself — not an error; proceed to send.
  }

  // Ephemeral signer first (replay protection), then the wallet. Signing comes AFTER the simulation
  // so an external signer sees the same pre-flight refusals a local one does.
  await signWithCosigners(signer, tx, [uniqueMsg], {
    what: "bridge",
    blockhash,
    lastValidBlockHeight,
    submit: { via: source.chain === "solana" ? "solana-rpc" : "cookie-rpc" },
    summary: {
      token: token.symbol,
      direction: args.direction,
      amount: String(args.amount),
      recipient: to,
      ...(recipientTokenAccount ? { recipientTokenAccount } : {}),
    },
  });

  const sourceSignature = await route.sourceConn.sendRawTransaction(tx.serialize());
  // A confirm timeout here does not mean the transfer failed — the dispatch may still land and the
  // relayer would then deliver it. Retrying would bridge the amount twice, so surface the signature
  // (on the SOURCE chain's explorer) instead of a bare timeout.
  await confirmSent(
    route.sourceConn,
    { signature: sourceSignature, blockhash, lastValidBlockHeight },
    "bridge",
    { explorerUrl: route.sourceExplorerTxUrl(sourceSignature) },
  );

  // Extract the Hyperlane message id from the dispatch tx logs. getTransaction can lag confirmation on
  // public RPCs (esp. Solana mainnet-beta), returning null for a few seconds after the tx confirms —
  // retry a few times before giving up (the transfer still dispatched; it's recoverable from the sig).
  let messageId: string | null = null;
  for (let attempt = 0; attempt < 6 && !messageId; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 2_500));
    try {
      const confirmed = await route.sourceConn.getTransaction(sourceSignature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      messageId = messageIdFromLogs(confirmed?.meta?.logMessages);
    } catch {
      /* transient — retry */
    }
  }

  let delivered = false;
  let destinationTx: string | null = null;
  if (args.waitForDelivery && messageId) {
    // Bounded poll (~3 min). Delivery is relayer-paced and varies (often <1 min, sometimes longer,
    // especially cookie→solana); a timeout here is NOT a failure — the transfer is still in flight.
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      const d = await isDelivered(route.destConn, dest.mailbox, messageId);
      if (d.delivered) {
        delivered = true;
        destinationTx = d.destinationTx;
        break;
      }
      await new Promise((r) => setTimeout(r, 5_000));
    }
  }

  const note = delivered
    ? "delivered on the destination chain"
    : !messageId
      ? "dispatched — could not read the message id from logs; check the source tx on the explorer"
      : args.waitForDelivery
        ? "dispatched, but not delivered within the ~3 min wait window — this is normal (relayer-paced), " +
          "NOT a failure; re-check delivery with bridge_status using the messageId below"
        : "dispatched — a relayer delivers on the destination chain in a few minutes; check with bridge_status";

  return {
    direction: args.direction,
    token: {
      symbol: token.symbol,
      sourceMint: source.mint?.toBase58() ?? null,
      destinationMint: dest.mint?.toBase58() ?? null,
    },
    from: sender.toBase58(),
    to,
    amount: String(args.amount),
    sourceSignature,
    sourceExplorerUrl: route.sourceExplorerTxUrl(sourceSignature),
    messageId,
    destinationDomain: route.destinationDomain,
    delivered,
    destinationTx,
    destinationCollateral,
    recipientTokenAccount,
    minimum,
    note: minimum
      ? note
      : `${note}. No price was available for ${token.symbol}, so the ` +
        `${MIN_BRIDGE_COOK.toLocaleString("en-US")} COOK minimum was not checked`,
  };
}

export interface BridgeStatusResult {
  messageId: string;
  direction: BridgeDirection;
  delivered: boolean;
  destinationTx: string | null;
  destinationExplorerUrl: string | null;
}

/** Check whether a bridged message has been delivered on the destination chain. A read-only lookup
 *  that needs only the destination mailbox — the same for every token, so no route or wallet. */
export async function bridgeStatus(args: {
  messageId: string;
  direction: BridgeDirection;
}): Promise<BridgeStatusResult> {
  const toSolana = args.direction === "cookie-to-solana";
  const destConn = toSolana ? getSolanaConnection() : getConnection();
  const destMailbox = new PublicKey(toSolana ? BRIDGE.solana.mailbox : BRIDGE.cookie.mailbox);
  const { delivered, destinationTx } = await isDelivered(destConn, destMailbox, args.messageId);
  // Destination explorer is the opposite chain's explorer.
  const destExplorer = toSolana ? solanaExplorerTxUrl : explorerTxUrl;
  return {
    messageId: args.messageId.toLowerCase(),
    direction: args.direction,
    delivered,
    destinationTx,
    destinationExplorerUrl: destinationTx ? destExplorer(destinationTx) : null,
  };
}
