// get_balance — native COOK + SPL/Token-2022 balances for a wallet, with USD values from the registry.
import { PublicKey, LAMPORTS_PER_SOL, type ParsedAccountData } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";

import { BRIDGE, COOK_MINT, COOK_SYMBOL, COOK_DECIMALS } from "./config";
import { looksLikeName, resolveWallet } from "./domains";
import { CookieMcpError } from "./errors";
import { getBridgeRoutes, type BridgeRoute } from "./bridgeRoutes";
import { fetchTokens, type CookiescanToken } from "./cookiescan";
import { getConnection, getSolanaConnection } from "./rpc";
import { rawToUi } from "./format";

// web3.js v1 doesn't export these from its base entrypoint.
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

export interface TokenBalance {
  mint: string;
  symbol: string | null;
  amount: string;
  decimals: number;
  usdValue: number | null;
}

export interface WalletBalances {
  wallet: string;
  /** The `.cook` name the wallet was looked up by, when one was used. */
  walletName?: string;
  cook: { amount: string; usdValue: number | null };
  tokens: TokenBalance[];
  totalUsd: number | null;
}

function parsePubkey(addr: string): PublicKey {
  try {
    return new PublicKey(addr);
  } catch {
    throw new CookieMcpError(`invalid wallet address: ${addr}`, "pass a valid base58 pubkey");
  }
}

/** The token-amount shape web3.js parses into each token account's `parsed.info`. */
export interface ParsedTokenAmount {
  mint: string;
  tokenAmount: { amount: string; decimals: number; uiAmount: number | null };
}

export async function getBalances(wallet: string): Promise<WalletBalances> {
  // A base58 address resolves locally; a `.cook` name costs one PDA read.
  const { pubkey: owner, name } = looksLikeName(wallet)
    ? await resolveWallet(wallet, "wallet address")
    : { pubkey: parsePubkey(wallet), name: null };
  const conn = getConnection();

  const [lamports, tokenAccts, token2022Accts, registry] = await Promise.all([
    conn.getBalance(owner),
    conn.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID }),
    conn.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_2022_PROGRAM_ID }),
    fetchTokens(),
  ]);

  const parsed: ParsedTokenAmount[] = [...tokenAccts.value, ...token2022Accts.value].map(
    ({ account }) => {
      const info = (account.data as { parsed: { info: Record<string, unknown> } }).parsed.info;
      return {
        mint: info.mint as string,
        tokenAmount: info.tokenAmount as ParsedTokenAmount["tokenAmount"],
      };
    },
  );
  const balances = mapBalances(owner.toBase58(), lamports, parsed, registry);
  return name ? { ...balances, walletName: name } : balances;
}

// Pure assembly of the balances view: join SPL/Token-2022 accounts against the registry for
// symbol/price, drop zero balances, sort by USD value desc, and total. No I/O, so it's unit-testable.
export function mapBalances(
  wallet: string,
  lamports: number,
  accounts: ParsedTokenAmount[],
  registry: CookiescanToken[],
): WalletBalances {
  const priceByMint = new Map<string, number>();
  const symbolByMint = new Map<string, string>();
  for (const t of registry) {
    const usd = t.price?.usd != null ? Number(t.price.usd) : NaN;
    if (t.mint && Number.isFinite(usd)) priceByMint.set(t.mint, usd);
    const sym = t.metadata?.symbol;
    if (t.mint && sym) symbolByMint.set(t.mint, sym);
  }

  const cookUi = rawToUi(BigInt(lamports), COOK_DECIMALS);
  const cookPrice = priceByMint.get(COOK_MINT) ?? null;
  const cookUsd = cookPrice != null ? (lamports / LAMPORTS_PER_SOL) * cookPrice : null;

  const tokens: TokenBalance[] = [];
  for (const { mint, tokenAmount: ta } of accounts) {
    if (!ta || ta.amount === "0") continue;
    const price = priceByMint.get(mint);
    const usdValue = price != null && ta.uiAmount != null ? ta.uiAmount * price : null;
    tokens.push({
      mint,
      symbol: symbolByMint.get(mint) ?? null,
      amount: rawToUi(BigInt(ta.amount), ta.decimals),
      decimals: ta.decimals,
      usdValue,
    });
  }
  tokens.sort((a, b) => (b.usdValue ?? -1) - (a.usdValue ?? -1));

  const totalUsd =
    cookUsd != null || tokens.some((t) => t.usdValue != null)
      ? (cookUsd ?? 0) + tokens.reduce((s, t) => s + (t.usdValue ?? 0), 0)
      : null;

  return {
    wallet,
    cook: { amount: cookUi, usdValue: cookUsd },
    tokens,
    totalUsd,
  };
}

export { COOK_SYMBOL };

// --- Solana mainnet side (the far end of the Hyperlane COOK bridge) -----------------------------
// `bridge {direction: "solana-to-cookie"}` spends SPL COOK held by the SAME keypair on Solana
// mainnet, and pays the Hyperlane interchain gas in SOL — neither of which the Cookie Chain view
// above can see. This reads just those two numbers off the mainnet connection: no token enumeration
// (the Cookiescan registry prices Cookie Chain mints, so a full Solana portfolio would be a list of
// unpriced mints), and COOK is priced off the registry since the warp route makes the two sides the
// same asset 1:1.
export interface SolanaBridgeBalances {
  wallet: string;
  chain: "solana";
  /** SPL COOK (Token-2022, 6 decimals) — the balance `solana-to-cookie` draws from. */
  cook: { amount: string; mint: string; decimals: number; usdValue: number | null };
  /** Native SOL — pays the tx fee, the ATA rent and the Hyperlane interchain gas payment. It is
   *  also what the SOL bridge route spends. */
  sol: { amount: string };
  /** Every other token the bridge can move out of Solana, discovered on-chain — so one added after
   *  this release shows up here too. Listed even at 0 so the caller sees what is bridgeable. */
  bridgeTokens: { symbol: string; mint: string; amount: string; decimals: number }[];
  /** Set when bridge-route discovery failed; `bridgeTokens` is then incomplete. */
  warnings?: string[];
}

function warningsField(warnings: string[]): { warnings?: string[] } {
  return warnings.length ? { warnings } : {};
}

/** Solana-side mints of the bridge routes that the COOK and SOL fields don't already cover: native
 *  SOL has no mint, and SPL COOK has its own field. */
export function solanaBridgeMints(
  routes: BridgeRoute[],
): { symbol: string; mint: PublicKey; decimals: number }[] {
  return routes
    .filter((r) => r.solana.mint && r.solana.mint.toBase58() !== BRIDGE.solana.splMint)
    .map((r) => ({ symbol: r.symbol, mint: r.solana.mint!, decimals: r.solana.decimals }));
}

/** The same, read from the discovered routes; a failed discovery is a warning, not an error. */
async function otherBridgeMints(): Promise<{
  mints: { symbol: string; mint: PublicKey; decimals: number }[];
  warnings: string[];
}> {
  try {
    const { routes, warnings } = await getBridgeRoutes();
    return { mints: solanaBridgeMints(routes), warnings };
  } catch (e) {
    return {
      mints: [],
      warnings: [
        `could not list the bridge's tokens (${(e as Error).message}); showing COOK and SOL only`,
      ],
    };
  }
}

/** Sum every account holding the mint — a wallet can hold it outside the canonical ATA, and the
 *  spendable balance is the total. Falls back to the configured decimals when it holds none. */
export function sumTokenAmounts(amounts: (ParsedTokenAmount["tokenAmount"] | undefined)[]): {
  raw: bigint;
  decimals: number;
} {
  let raw = 0n;
  let decimals: number = BRIDGE.solana.decimals;
  for (const ta of amounts) {
    if (!ta) continue;
    raw += BigInt(ta.amount);
    decimals = ta.decimals;
  }
  return { raw, decimals };
}

export async function getSolanaBalances(wallet: string): Promise<SolanaBridgeBalances> {
  const { pubkey: owner, name } = looksLikeName(wallet)
    ? await resolveWallet(wallet, "wallet address")
    : { pubkey: parsePubkey(wallet), name: null };
  void name; // a `.cook` name resolves to the same keypair on both chains
  const conn = getSolanaConnection();
  const mint = new PublicKey(BRIDGE.solana.splMint);

  // Query by mint rather than deriving the ATA: a wallet can hold the mint in a non-canonical
  // account, and summing every account is what a sender's spendable balance actually is.
  // Some RPC plans (e.g. Shyft's free tier) refuse getTokenAccountsByOwner as an "index" method.
  // Then read the wallet's canonical associated account instead: right for almost every wallet, but
  // it misses tokens held in any other account, so the result says so.
  let ownerIndexRefused = false;
  const heldAmounts = async (m: PublicKey): Promise<ParsedTokenAmount["tokenAmount"][]> => {
    try {
      return (await conn.getParsedTokenAccountsByOwner(owner, { mint: m })).value.map(
        ({ account }) =>
          (account.data as { parsed: { info: Record<string, unknown> } }).parsed.info
            .tokenAmount as ParsedTokenAmount["tokenAmount"],
      );
    } catch {
      ownerIndexRefused = true;
      const mintInfo = await conn.getAccountInfo(m, "confirmed");
      if (!mintInfo) return [];
      const ata = getAssociatedTokenAddressSync(m, owner, true, mintInfo.owner);
      const info = await conn.getParsedAccountInfo(ata, "confirmed");
      const parsed = (info.value?.data as ParsedAccountData | undefined)?.parsed;
      const amount = parsed?.info?.tokenAmount as ParsedTokenAmount["tokenAmount"] | undefined;
      return amount ? [amount] : [];
    }
  };
  const [lamports, cookAmounts, registry, others] = await Promise.all([
    conn.getBalance(owner),
    heldAmounts(mint),
    fetchTokens(),
    otherBridgeMints(),
  ]);
  const bridgeTokens = await Promise.all(
    others.mints.map(async (t) => {
      const held = sumTokenAmounts(await heldAmounts(t.mint));
      // sumTokenAmounts falls back to COOK's decimals when nothing is held; use the route's.
      const decimals = held.raw === 0n ? t.decimals : held.decimals;
      return {
        symbol: t.symbol,
        mint: t.mint.toBase58(),
        amount: rawToUi(held.raw, decimals),
        decimals,
      };
    }),
  );

  const { raw, decimals } = sumTokenAmounts(cookAmounts);

  const cookPrice = registry.find((t) => t.mint === COOK_MINT)?.price?.usd;
  const price = cookPrice != null ? Number(cookPrice) : NaN;
  const amount = rawToUi(raw, decimals);
  return {
    wallet: owner.toBase58(),
    chain: "solana",
    cook: {
      amount,
      mint: mint.toBase58(),
      decimals,
      usdValue: Number.isFinite(price) ? Number(amount) * price : null,
    },
    sol: { amount: rawToUi(BigInt(lamports), 9) },
    bridgeTokens,
    ...warningsField([
      ...others.warnings,
      ...(ownerIndexRefused
        ? [
            "this Solana RPC refuses getTokenAccountsByOwner, so only each token's standard " +
              "(associated) account was read — tokens held in any other account are not counted. " +
              "Point SOLANA_RPC_URL at an RPC that allows it for a complete balance.",
          ]
        : []),
    ]),
  };
}
