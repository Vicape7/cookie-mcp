// bridgeMinimum — the smallest transfer `bridge` accepts: whatever is worth MIN_BRIDGE_COOK, in the
// token being bridged.
//
// Why a minimum at all: Hyperlane relay cost is per message, not per amount, so a dust transfer is all
// fee and no value — and a first-time recipient also costs an account's rent. Why priced in COOK: one
// figure then means the same thing for every token, including ones added after this release.
//
// Where the price comes from, most trustworthy first:
//   1. COOK itself needs no price.
//   2. Jupiter on Solana: what MIN_BRIDGE_COOK of SPL COOK buys of the token right now. Solana has
//      real liquidity for COOK, and a ~$1 quote barely moves it.
//   3. The Cookiescan registry's COOK price for the Cookie-side mint — for a token with no Solana
//      market. Weaker: it comes from Cookie Chain pools, which can be thin (the SOL pool held about a
//      cent when this was written), so it is only a fallback.
// With no price, the minimum is skipped rather than blocking the bridge, and the result says so.
import { BRIDGE, SOL_MINT } from "./config";
import type { BridgeRoute } from "./bridgeRoutes";
import { fetchTokens } from "./cookiescan";
import { quoteJup } from "./jupiter";

export const MIN_BRIDGE_COOK = 15_000;

export type MinimumBasis = "cook" | "jupiter" | "cookiescan";

export interface BridgeMinimum {
  /** The minimum in raw units at `decimals` (one side's; the caller rescales to its source side). */
  raw: bigint;
  decimals: number;
  basis: MinimumBasis;
}

/** Raw units of a token worth `minCook` COOK at `priceCook` COOK per token, rounded up. Null for a
 *  price that is missing, zero, negative or not a number — never a minimum of 0 or Infinity. */
export function minRawFromPriceCook(
  priceCook: number | null | undefined,
  decimals: number,
  minCook: number = MIN_BRIDGE_COOK,
): bigint | null {
  if (typeof priceCook !== "number" || !Number.isFinite(priceCook) || priceCook <= 0) return null;
  const raw = Math.ceil((minCook / priceCook) * 10 ** decimals);
  return Number.isFinite(raw) && raw > 0 ? BigInt(raw) : null;
}

/** The minimum for a token that IS COOK, at that side's decimals. */
export function cookMinimumRaw(decimals: number, minCook: number = MIN_BRIDGE_COOK): bigint {
  return BigInt(minCook) * 10n ** BigInt(decimals);
}

async function computeMinimum(token: BridgeRoute): Promise<BridgeMinimum | null> {
  const { cookie, solana } = token;
  // The COOK route: native COOK on Cookie, SPL COOK on Solana.
  if (cookie.type === "native" || solana.mint?.toBase58() === BRIDGE.solana.splMint) {
    return { raw: cookMinimumRaw(cookie.decimals), decimals: cookie.decimals, basis: "cook" };
  }

  // Jupiter speaks wSOL for native SOL.
  const outputMint = solana.mint?.toBase58() ?? SOL_MINT;
  try {
    const q = await quoteJup(
      BRIDGE.solana.splMint,
      outputMint,
      cookMinimumRaw(BRIDGE.solana.decimals).toString(),
      50,
    );
    const out = q ? BigInt(q.outAmount) : 0n;
    if (out > 0n) return { raw: out, decimals: solana.decimals, basis: "jupiter" };
  } catch {
    /* Jupiter down or rate-limited — try the registry */
  }

  if (cookie.mint) {
    try {
      const t = (await fetchTokens()).find((x) => x.mint === cookie.mint!.toBase58());
      const raw = minRawFromPriceCook(t?.price?.native, cookie.decimals);
      if (raw) return { raw, decimals: cookie.decimals, basis: "cookiescan" };
    } catch {
      /* registry down — no price */
    }
  }
  return null;
}

const CACHE_TTL_MS = 5 * 60_000;
const cache = new Map<string, { at: number; value: BridgeMinimum | null }>();

/** The bridge minimum for a token, cached for 5 minutes. Null when no price could be found. */
export async function getBridgeMinimum(token: BridgeRoute): Promise<BridgeMinimum | null> {
  const key = token.cookie.warp.toBase58();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  const value = await computeMinimum(token);
  // Don't remember a miss: the next call should try the price sources again.
  if (value) cache.set(key, { at: Date.now(), value });
  return value;
}

export const MINIMUM_BASIS_LABEL: Record<MinimumBasis, string> = {
  cook: "COOK needs no price",
  jupiter: "priced on Solana via Jupiter",
  cookiescan: "priced from the Cookiescan registry (Cookie Chain pools)",
};
