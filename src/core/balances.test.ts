import { describe, it, expect } from "vitest";
import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";

import {
  mapBalances,
  solanaBridgeMints,
  sumTokenAmounts,
  type ParsedTokenAmount,
} from "./balances";
import { COOK_MINT } from "./config";
import type { CookiescanToken } from "./cookiescan";

const MINT_A = "6H7xnYfBFeEU8S8mhrZRkFNS5vEegRqEwv7h42WbntCL";
const MINT_B = "FFWfqNZGQKun8d1iePAnqkrob359Do2qXwV7CqvF4wq2";
const WALLET = "So11111111111111111111111111111111111111112";

const registry: CookiescanToken[] = [
  { mint: COOK_MINT, metadata: { symbol: "COOK" }, price: { usd: "2" } },
  { mint: MINT_A, metadata: { symbol: "AAA" }, price: { usd: "0.5" } },
  { mint: MINT_B, metadata: { symbol: "BBB" } }, // no price
];

function acct(
  mint: string,
  amount: string,
  decimals: number,
  uiAmount: number | null,
): ParsedTokenAmount {
  return { mint, tokenAmount: { amount, decimals, uiAmount } };
}

describe("mapBalances", () => {
  it("values the native COOK balance from the registry price", () => {
    const b = mapBalances(WALLET, 3 * LAMPORTS_PER_SOL, [], registry);
    expect(b.wallet).toBe(WALLET);
    expect(b.cook.amount).toBe("3");
    expect(b.cook.usdValue).toBe(6); // 3 COOK * $2
    expect(b.tokens).toEqual([]);
    expect(b.totalUsd).toBe(6);
  });

  it("joins tokens to symbol/price, skips zero balances, sorts by USD desc", () => {
    const accounts = [
      acct(MINT_A, "100000000", 6, 100), // AAA: 100 * $0.5 = $50
      acct(MINT_B, "5000000000", 9, 5), // BBB: no price -> null usd
      acct("ZeroMint111111111111111111111111111111111", "0", 6, 0), // dropped
    ];
    const b = mapBalances(WALLET, 0, accounts, registry);
    expect(b.tokens.map((t) => t.mint)).toEqual([MINT_A, MINT_B]); // priced first
    expect(b.tokens[0].symbol).toBe("AAA");
    expect(b.tokens[0].amount).toBe("100");
    expect(b.tokens[0].usdValue).toBe(50);
    expect(b.tokens[1].usdValue).toBeNull();
    expect(b.tokens.some((t) => t.amount === "0")).toBe(false);
    expect(b.totalUsd).toBe(50); // cook has no balance/price here
  });

  it("returns null totalUsd when nothing is priced", () => {
    const b = mapBalances(
      WALLET,
      1 * LAMPORTS_PER_SOL,
      [acct(MINT_B, "1000000000", 9, 1)],
      [{ mint: MINT_B, metadata: { symbol: "BBB" } }],
    );
    expect(b.cook.usdValue).toBeNull();
    expect(b.tokens[0].usdValue).toBeNull();
    expect(b.totalUsd).toBeNull();
  });

  it("falls back to null symbol for mints missing from the registry", () => {
    const b = mapBalances(WALLET, 0, [acct(MINT_A, "1000000", 6, 1)], []);
    expect(b.tokens[0].symbol).toBeNull();
    expect(b.tokens[0].usdValue).toBeNull();
  });
});

describe("sumTokenAmounts", () => {
  const ta = (amount: string, decimals = 6) => ({ amount, decimals, uiAmount: null });

  it("sums every account holding the mint", () => {
    expect(sumTokenAmounts([ta("4000000000000"), ta("1500000")])).toEqual({
      raw: 4000001500000n,
      decimals: 6,
    });
  });

  it("falls back to the bridge decimals when the wallet holds none", () => {
    expect(sumTokenAmounts([])).toEqual({ raw: 0n, decimals: 6 });
  });

  it("skips accounts with no parsed amount", () => {
    expect(sumTokenAmounts([undefined, ta("7")])).toEqual({ raw: 7n, decimals: 6 });
  });
});

describe("solanaBridgeMints", () => {
  const side = (mint: string | null, decimals = 9) => ({
    chain: "solana" as const,
    warp: new PublicKey("DWxkDF63gF5pMoAiACjkkYgr4onz4WPZi9wq59gctU6T"),
    type: (mint ? "collateral" : "native") as "collateral" | "native",
    mint: mint ? new PublicKey(mint) : null,
    tokenProgram: null,
    decimals,
    mailbox: new PublicKey("E588QtVUvresuXq2KoNEwAmoifCzYGpRBdHByN9KQMbi"),
    igp: null,
  });
  const route = (symbol: string, solana: ReturnType<typeof side>) => ({
    symbol,
    name: null,
    cookie: { ...side(null), chain: "cookie" as const },
    solana,
  });
  const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

  it("lists a token added to the bridge, but not SOL (no mint) or COOK (its own field)", () => {
    const out = solanaBridgeMints([
      route("COOK", side("36ZrtQoab5MhhySaP1YSTwUahSk6GRVUTtZ6cuVfm9e1", 6)),
      route("SOL", side(null)),
      route("USDC", side(USDC, 6)),
    ]);
    expect(out.map((t) => [t.symbol, t.mint.toBase58(), t.decimals])).toEqual([["USDC", USDC, 6]]);
  });
});
