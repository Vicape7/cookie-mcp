import { describe, it, expect } from "vitest";
import { PublicKey } from "@solana/web3.js";

import {
  deriveAtaPayerPda,
  deriveNativeCollateralPda,
  deriveSyntheticMintPda,
  deriveTokenPda,
  matchRoute,
  pairRoute,
  parseHyperlaneToken,
  type BridgeRoute,
  type HyperlaneTokenAccount,
} from "./bridgeRoutes";

// HyperlaneToken accounts of the four mainnet warp programs, captured 2026-09-27 with
// getAccountInfo(deriveTokenPda(warp)). Golden bytes: they pin the borsh layout, the plugin sizes and
// the router wiring that discovery relies on, without a cluster.
const COOKIE_COOK =
  "Af28uijV3/wZrL7vzlKZQiPj6YaMX/xzk7jkwMRlAaClz0ORnUJoxCXok7rhyl2oXZZX/0pkvVWxk57jRpAy43gV/wkJAd+VE7O81UTAz07D0Ia0V0VlbGi2bDpAW3agrQPxTeyEAdu2Bn9wjQWmQxeSh0QASAHclH5FUg1npGIujOQNM3BPAdIS2ztE623OyDFE40GtgWO6VYAJ2MjR96R9VFmLOycbAZVhfhEJL4j+/ZoAnFPUN21a9nsbNV8KqCo07zpg44yQAQAAAE1sb1OgCQEAAAAAAAEAAABNbG9TlKF2lMbNa+Cb8NUlLuaf4SywabJqhy/WQ9wVTPZiqib7";
const COOKIE_SOL =
  "Af28uijV3/wZrL7vzlKZQiPj6YaMX/xzk7jkwMRlAaClzwlnD4sFrEkj1Tga+Aqq8IOA3fNC/sH9Yi9YPdGd8nM5/wkJAd+VE7O81UTAz07D0Ia0V0VlbGi2bDpAW3agrQPxTeyEAdu2Bn9wjQWmQxeSh0QASAHclH5FUg1npGIujOQNM3BPAdIS2ztE623OyDFE40GtgWO6VYAJ2MjR96R9VFmLOycbAZVhfhEJL4j+/ZoAnFPUN21a9nsbNV8KqCo07zpg44yQAQAAAE1sb1PgqwAAAAAAAAEAAABNbG9TufkeH9EaZ0Cl8ZNpqo1oDTLjHRCKTLB4twuFRFk93pBXcI9SdVQI8w0T8XWE4VRXR/nM/mQMmU8NuarBSjQbuP79";
const SOLANA_COOK =
  "AfzCNlAM8QxAnfVmsUFbmWeckoUHK/hW/jEbPMG7lGJ5pUDXuaXAJdWErs53iM4I0uJ54nfBZjBS8x3oWlbaOtZ//wYJAb44ntf/4rcb+D1I3IJFRnrnj3EtZkb+3BvLj+Q01eb7Acy45yF5E8dVM/HPRziZrYlM95gsKmqOeTW892SkxnzIAZ7sikTh0Jc6oFWNV+/fyK0sKt1zOeXqkkW0AoHptJxFAbxOsZSq7NFgusOiBdUja0vaLJsUJdGWoC5f+uHGo1NrAQAAABRVCRngqwAAAAAAAAEAAAAUVQkZjjd2qqIUWbx1tIhwNOhwiDrUJQO9JUeTsdXtzcEmw90G3fbh7nWP3hhCXbzkbM3athr8TYO5DSf+vfko2KGL/B8kbtVauN3XBDZECCpXcKlwLfy4bde1r7mvoAvqPOPCagNIyQk4jcWaf/6Cq2Mnx9AFT1PaFgEoWR/OaRoPEfT+/w==";
const SOLANA_SOL =
  "Af7CNlAM8QxAnfVmsUFbmWeckoUHK/hW/jEbPMG7lGJ5pRix8wEtfEktdgMAagrUra8FzUleizIsw5PnPhfdLyvy/wkJAb44ntf/4rcb+D1I3IJFRnrnj3EtZkb+3BvLj+Q01eb7Acy45yF5E8dVM/HPRziZrYlM95gsKmqOeTW892SkxnzIAZ7sikTh0Jc6oFWNV+/fyK0sKt1zOeXqkkW0AoHptJxFAbxOsZSq7NFgusOiBdUja0vaLJsUJdGWoC5f+uHGo1NrAQAAABRVCRkA+gAAAAAAAAEAAAAUVQkZw3VkPrXJ1Nxezy0+licfPQ1VViccmlH4wmoZ9r4ThEf+";

const pk = (s: string) => new PublicKey(s);
const parse = (b64: string) => parseHyperlaneToken(Buffer.from(b64, "base64"));

const W = {
  cookieCook: pk("Aa9wq46NB7qkg1amnBuMRsV1DunmkPHuoRLWZgWiBKdn"),
  cookieSol: pk("E9zKioziEnQkc3v4pU9zVmVHi9dg6gKoD2qSnzY5sASi"),
  solanaCook: pk("B1C91jLcqXYYz57bBWR8dSEjBrJDhWSeNokZ5SDEopu3"),
  solanaSol: pk("DWxkDF63gF5pMoAiACjkkYgr4onz4WPZi9wq59gctU6T"),
};
const COOKIE_MAILBOX = pk("DhiHgUY8Y6mJ4D3MoRnZWAjTBEtSaFFn4CYgc6eDzZ8r");
const SOLANA_MAILBOX = pk("E588QtVUvresuXq2KoNEwAmoifCzYGpRBdHByN9KQMbi");
const COOKIE_DOMAIN = 420042004;
const SOLANA_DOMAIN = 1399811149;
const SOL_MINT_ON_COOKIE = "6tL24Fn75uCMrBSZAvohAq57LSv6KrY6ceEq1wonvucb";
const COOK_MINT_ON_SOLANA = "36ZrtQoab5MhhySaP1YSTwUahSk6GRVUTtZ6cuVfm9e1";

describe("PDA derivation for the SOL route (golden, from program-ids.json)", () => {
  it("derives the synthetic SOL mint, the Solana native collateral and the Cookie ATA payer", () => {
    expect(deriveSyntheticMintPda(W.cookieSol).toBase58()).toBe(SOL_MINT_ON_COOKIE);
    expect(deriveNativeCollateralPda(W.solanaSol).toBase58()).toBe(
      "ADLE5sXddiFWpAfExBqjoHNfG8ALRJEhDAtLd5wd6eXe",
    );
    expect(deriveAtaPayerPda(W.cookieSol).toBase58()).toBe(
      "GjrajPeUSF7B6h1YEt9L7qJuLCLutvx8e9U3hXYf3CPS",
    );
  });

  it("derives the token account the fixtures were read from", () => {
    expect(deriveTokenPda(W.cookieCook).toBase58()).toBe(
      "5jjRnHx1RBNBUtQVzTMB7unUfdfR9pruVwxpNn4qDGgo",
    );
  });
});

describe("parseHyperlaneToken", () => {
  it("reads the Cookie COOK route as native, 9 decimals, overhead IGP, routed to the Solana COOK warp", () => {
    const t = parse(COOKIE_COOK);
    expect(t.mailbox.equals(COOKIE_MAILBOX)).toBe(true);
    expect(t.decimals).toBe(9);
    expect(t.remoteDecimals).toBe(9);
    expect(t.plugin).toEqual({ type: "native" });
    expect(t.igp?.kind).toBe("overheadIgp");
    expect(t.igp?.program.toBase58()).toBe("F93J1LCWZVZGtiv2yWu1mZeyCbFJNUh9aWEonWN6eSRp");
    expect(t.igp?.account.toBase58()).toBe("B47yFLwnEGxp3oFHyy2LdGCmAe6kTbFmzSjkVoFaod9q");
    expect(t.remoteRouters.get(SOLANA_DOMAIN)?.equals(W.solanaCook)).toBe(true);
  });

  it("reads the Cookie SOL route as synthetic with the mint PDA", () => {
    const t = parse(COOKIE_SOL);
    expect(t.plugin.type).toBe("synthetic");
    expect(t.plugin.type === "synthetic" && t.plugin.mint.toBase58()).toBe(SOL_MINT_ON_COOKIE);
    expect(t.remoteRouters.get(SOLANA_DOMAIN)?.equals(W.solanaSol)).toBe(true);
  });

  it("reads the Solana COOK route as a 6-decimal collateral route over the Token-2022 mint", () => {
    const t = parse(SOLANA_COOK);
    expect(t.mailbox.equals(SOLANA_MAILBOX)).toBe(true);
    expect(t.decimals).toBe(6);
    expect(t.remoteDecimals).toBe(9);
    expect(t.igp?.program.toBase58()).toBe("BhNcatUDC2D5JTyeaqrdSukiVFsEHK7e3hVmKMztwefv");
    expect(t.igp?.account.toBase58()).toBe("Dg5FAhqNaRfQPc3HwW9fXr7Bj4nrnszoQspoSLgysqfY");
    if (t.plugin.type !== "collateral") throw new Error("expected collateral");
    expect(t.plugin.mint.toBase58()).toBe(COOK_MINT_ON_SOLANA);
    expect(t.plugin.tokenProgram.toBase58()).toBe("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
    expect(t.plugin.escrow.toBase58()).toBe("88q7zoKctwAQRsoTxkMJy95sNE3tntuyEhSrhvR1eZwq");
    expect(t.remoteRouters.get(COOKIE_DOMAIN)?.equals(W.cookieCook)).toBe(true);
  });

  it("reads the Solana SOL route as native, routed back to the Cookie SOL warp", () => {
    const t = parse(SOLANA_SOL);
    expect(t.plugin).toEqual({ type: "native" });
    expect(t.remoteRouters.get(COOKIE_DOMAIN)?.equals(W.cookieSol)).toBe(true);
  });

  it("refuses an uninitialized, truncated or unrecognised account", () => {
    const data = Buffer.from(COOKIE_COOK, "base64");
    const uninit = Buffer.from(data);
    uninit[0] = 0;
    expect(() => parseHyperlaneToken(uninit)).toThrow(/not initialized/);
    expect(() => parseHyperlaneToken(data.subarray(0, 120))).toThrow(/truncated/);
    // Two plugin bytes instead of one fits none of the three plugin layouts.
    expect(() => parseHyperlaneToken(Buffer.concat([data, Buffer.from([0])]))).toThrow(
      /unrecognised warp plugin/,
    );
  });
});

describe("pairRoute (the discovery trust check)", () => {
  const base = { cookieMailbox: COOKIE_MAILBOX, solanaMailbox: SOLANA_MAILBOX };
  const cook = {
    cookieWarp: W.cookieCook,
    cookieToken: parse(COOKIE_COOK),
    solanaWarp: W.solanaCook,
    solanaToken: parse(SOLANA_COOK),
  };
  const sol = {
    cookieWarp: W.cookieSol,
    cookieToken: parse(COOKIE_SOL),
    solanaWarp: W.solanaSol,
    solanaToken: parse(SOLANA_SOL),
  };

  it("pairs both live routes with the right side types, mints and token programs", () => {
    const c = pairRoute({ ...base, ...cook })!;
    expect([c.cookie.type, c.solana.type]).toEqual(["native", "collateral"]);
    expect(c.cookie.mint).toBeNull();
    expect(c.solana.mint?.toBase58()).toBe(COOK_MINT_ON_SOLANA);
    const s = pairRoute({ ...base, ...sol })!;
    expect([s.cookie.type, s.solana.type]).toEqual(["synthetic", "native"]);
    expect(s.cookie.mint?.toBase58()).toBe(SOL_MINT_ON_COOKIE);
    expect(s.cookie.tokenProgram?.toBase58()).toBe("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
  });

  it("rejects a Solana program whose router does not point back", () => {
    expect(
      pairRoute({ ...base, ...cook, solanaWarp: W.solanaSol, solanaToken: parse(SOLANA_SOL) }),
    ).toBeNull();
  });

  it("rejects either side on the wrong mailbox", () => {
    expect(
      pairRoute({ ...cook, cookieMailbox: SOLANA_MAILBOX, solanaMailbox: SOLANA_MAILBOX }),
    ).toBeNull();
    expect(
      pairRoute({ ...cook, cookieMailbox: COOKIE_MAILBOX, solanaMailbox: COOKIE_MAILBOX }),
    ).toBeNull();
  });

  it("rejects plugin data that is not the program's own PDA", () => {
    const forged: HyperlaneTokenAccount = {
      ...sol.cookieToken,
      plugin: { type: "synthetic", mint: pk(COOK_MINT_ON_SOLANA) },
    };
    expect(pairRoute({ ...base, ...sol, cookieToken: forged })).toBeNull();
  });
});

describe("matchRoute", () => {
  const pairs = [
    pairRoute({
      cookieMailbox: COOKIE_MAILBOX,
      solanaMailbox: SOLANA_MAILBOX,
      cookieWarp: W.cookieCook,
      cookieToken: parse(COOKIE_COOK),
      solanaWarp: W.solanaCook,
      solanaToken: parse(SOLANA_COOK),
    })!,
    pairRoute({
      cookieMailbox: COOKIE_MAILBOX,
      solanaMailbox: SOLANA_MAILBOX,
      cookieWarp: W.cookieSol,
      cookieToken: parse(COOKIE_SOL),
      solanaWarp: W.solanaSol,
      solanaToken: parse(SOLANA_SOL),
    })!,
  ];
  const routes: BridgeRoute[] = [
    { symbol: "COOK", name: null, ...pairs[0] },
    { symbol: "SOL", name: null, ...pairs[1] },
  ];

  it("matches a symbol case-insensitively", () => {
    expect(matchRoute(routes, "sol").symbol).toBe("SOL");
    expect(matchRoute(routes, " COOK ").symbol).toBe("COOK");
  });

  it("matches the mint of either side", () => {
    expect(matchRoute(routes, SOL_MINT_ON_COOKIE).symbol).toBe("SOL");
    expect(matchRoute(routes, COOK_MINT_ON_SOLANA).symbol).toBe("COOK");
  });

  it("does not treat So111… as a native asset — it means different coins on each chain", () => {
    expect(() => matchRoute(routes, "So11111111111111111111111111111111111111112")).toThrow(
      /no bridge route/,
    );
  });

  it("lists what is bridgeable when nothing matches, and asks for a mint when a symbol is shared", () => {
    expect(() => matchRoute(routes, "USDC")).toThrow(/no bridge route/);
    try {
      matchRoute(routes, "USDC");
    } catch (e) {
      expect((e as { hint?: string }).hint).toMatch(/COOK, SOL/);
    }
    const dup = [...routes, { ...routes[1] }];
    expect(() => matchRoute(dup, "SOL")).toThrow(/matches 2 bridge routes/);
  });
});
