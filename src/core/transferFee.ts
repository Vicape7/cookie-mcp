// Token-2022 mints in the escrow flows — a launch token may carry a TransferFeeConfig (a holder
// tax, frozen at launch) charged on every transfer.
//
// The limit-order and DCA programs accept such mints once their transfer-fee upgrades are
// deployed, and the Cookiebox aggregator builds the transactions (gated by
// `limitOrders/dcaOrders.transferFeeMints`). What this server has to know to keep verifying those
// builds against ITS OWN numbers:
//   - each side's ATA is derived under the mint's own token program;
//   - a taxed reserve holds its deposit's tax withheld inside itself and Token-2022 will not close
//     it until `HarvestWithheldTokensToMint` sweeps it, so the builds carry that instruction;
//   - the DCA builder re-sizes the slice (and scales the band) so the cycle count holds on what
//     arrives — recomputed here with the exact same math, never read back from the API.
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getEpochFee,
  getTransferFeeConfig,
  unpackMint,
} from "@solana/spl-token";
import { PublicKey, type Connection } from "@solana/web3.js";

import type { DecodedIx } from "./txVerify";

export interface TransferFeeRate {
  bps: number;
  /** Absolute cap per transfer, base units. */
  maxFee: bigint;
}

export interface MintProgram {
  /** The token program that owns the mint — and therefore our ATA for it. */
  program: PublicKey;
  /** The epoch's active transfer fee, or null (SPL mint, no extension, or a zero rate). */
  transferFee: TransferFeeRate | null;
}

const SPL: MintProgram = { program: TOKEN_PROGRAM_ID, transferFee: null };
const BPS = 10_000n;

/** Token program + active transfer fee per mint, keyed by base58 — one batched read. */
export async function fetchMintPrograms(
  connection: Connection,
  mints: PublicKey[],
): Promise<Map<string, MintProgram>> {
  const out = new Map<string, MintProgram>();
  const unique = [...new Map(mints.map((m) => [m.toBase58(), m])).values()];
  if (unique.length === 0) return out;
  const infos = await connection.getMultipleAccountsInfo(unique, "confirmed");
  const needsEpoch = infos.some((i) => i?.owner.equals(TOKEN_2022_PROGRAM_ID));
  const epoch = needsEpoch ? (await connection.getEpochInfo("confirmed")).epoch : 0;
  unique.forEach((mint, i) => {
    const info = infos[i];
    if (!info || !info.owner.equals(TOKEN_2022_PROGRAM_ID)) {
      out.set(mint.toBase58(), SPL);
      return;
    }
    let transferFee: TransferFeeRate | null = null;
    const config = getTransferFeeConfig(unpackMint(mint, info, TOKEN_2022_PROGRAM_ID));
    if (config) {
      const fee = getEpochFee(config, BigInt(epoch));
      if (fee.transferFeeBasisPoints > 0) {
        transferFee = { bps: fee.transferFeeBasisPoints, maxFee: fee.maximumFee };
      }
    }
    out.set(mint.toBase58(), { program: TOKEN_2022_PROGRAM_ID, transferFee });
  });
  return out;
}

export function mintProgramOf(map: Map<string, MintProgram>, mint: PublicKey): MintProgram {
  return map.get(mint.toBase58()) ?? SPL;
}

/** Token-2022's fee on a transfer: `ceil(amount × bps / 1e4)`, capped. */
export function transferFeeOn(amount: bigint, rate: TransferFeeRate | null | undefined): bigint {
  if (!rate || rate.bps === 0 || amount <= 0n) return 0n;
  const fee = (amount * BigInt(rate.bps) + BPS - 1n) / BPS;
  return fee > rate.maxFee ? rate.maxFee : fee;
}

export function netOfTransferFee(amount: bigint, rate: TransferFeeRate | null | undefined): bigint {
  return amount - transferFeeOn(amount, rate);
}

export interface DcaSizing {
  inDeposited: bigint;
  inAmountPerCycle: bigint;
  minOutAmount: bigint;
  maxOutAmount: bigint;
}

/**
 * EXACTLY cookiebox `src/solana/dca/schedules.ts` `resizeForTaxedDeposit`, which the agg's open
 * builder applies before encoding `open_dca`: keep the caller's cycle count `N = ceil(D / per)` on
 * what ARRIVES (`per = ceil(arrived / N)`) and scale the per-slice band with it (floor rounded up,
 * ceiling down). Identity without a fee. A copy that drifts from the agg's makes every taxed open
 * fail verification — refused, never mis-signed — so the two are pinned by the same test vectors.
 */
export function resizeForTaxedDeposit(
  s: DcaSizing,
  rate: TransferFeeRate | null | undefined,
): DcaSizing {
  if (!rate || s.inAmountPerCycle <= 0n) return s;
  const arrived = netOfTransferFee(s.inDeposited, rate);
  if (arrived <= 0n || arrived === s.inDeposited) return s;
  const cycles = (s.inDeposited + s.inAmountPerCycle - 1n) / s.inAmountPerCycle;
  const per = (arrived + cycles - 1n) / cycles;
  const scale = (v: bigint, up: boolean) =>
    v === 0n
      ? 0n
      : up
        ? (v * per + s.inAmountPerCycle - 1n) / s.inAmountPerCycle
        : (v * per) / s.inAmountPerCycle;
  return {
    inDeposited: s.inDeposited,
    inAmountPerCycle: per,
    minOutAmount: scale(s.minOutAmount, true),
    maxOutAmount: scale(s.maxOutAmount, false),
  };
}

/** Token-2022 `TransferFeeExtension` (26) → `HarvestWithheldTokensToMint` (4). */
export const TOKEN_2022_IX_TRANSFER_FEE_EXTENSION = 26;
export const TRANSFER_FEE_IX_HARVEST_TO_MINT = 4;

/**
 * The ONE Token-2022 instruction an escrow build may carry: harvesting the tax withheld on THIS
 * flow's reserve into its own mint — `[mint (w), ...sources (w)]`, data `[26, 4]`. It moves only
 * the withheld tax (never anyone's balance) and only from accounts we name.
 */
export function harvestIxMatcher(mint: PublicKey, reserve: PublicKey): (ix: DecodedIx) => boolean {
  return (ix) =>
    ix.programId.equals(TOKEN_2022_PROGRAM_ID) &&
    ix.data.length === 2 &&
    ix.data[0] === TOKEN_2022_IX_TRANSFER_FEE_EXTENSION &&
    ix.data[1] === TRANSFER_FEE_IX_HARVEST_TO_MINT &&
    ix.keys.length === 2 &&
    ix.keys[0]!.equals(mint) &&
    ix.keys[1]!.equals(reserve);
}
