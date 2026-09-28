import { describe, it, expect } from "vitest";

import { MIN_BRIDGE_COOK, cookMinimumRaw, minRawFromPriceCook } from "./bridgeMinimum";

describe("cookMinimumRaw", () => {
  it("is 15,000 COOK at either side's decimals", () => {
    expect(MIN_BRIDGE_COOK).toBe(15_000);
    expect(cookMinimumRaw(9)).toBe(15_000_000_000_000n); // native COOK on Cookie Chain
    expect(cookMinimumRaw(6)).toBe(15_000_000_000n); // SPL COOK on Solana
  });
});

describe("minRawFromPriceCook", () => {
  it("converts 15,000 COOK into the token at its COOK price, rounded up", () => {
    // SOL at 1,557,987.56 COOK (the registry price on 2026-09-27): 15,000 / 1,557,987.56 SOL.
    expect(minRawFromPriceCook(1_557_987.5642058202, 9)).toBe(9_627_805n);
    // A token worth 0.5 COOK with 6 decimals: 30,000 tokens.
    expect(minRawFromPriceCook(0.5, 6)).toBe(30_000_000_000n);
  });

  it("never rounds a minimum down to below its value", () => {
    // 15,000 / 7 = 2142.857142…; at 0 decimals that must be 2143, not 2142.
    expect(minRawFromPriceCook(7, 0)).toBe(2143n);
  });

  it("returns null instead of a 0 or infinite minimum for a missing or bad price", () => {
    for (const bad of [null, undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(minRawFromPriceCook(bad, 9)).toBeNull();
    }
  });
});
