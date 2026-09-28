// bridgeRoutes — which tokens the Hyperlane bridge can move, discovered on-chain.
//
// Every warp route is a pair of programs: one on Cookie Chain, one on Solana, each enrolled as the
// other's remote router. Nothing about a route is hardcoded here. The one thing we have to trust is
// WHICH Cookie programs are the bridge's, and that is the program's upgrade authority: every warp
// route the Cookie team deploys is owned by the same authority (the Squads vault that also owns the
// mailbox and IGP). So:
//
//   1. list every program on Cookie Chain whose upgrade authority is that account,
//   2. read each one's HyperlaneToken account — the ones that aren't warp routes don't have one,
//   3. keep those on the Cookie mailbox with a router enrolled for Solana,
//   4. read the Solana program that router names, and require it to be on the Solana mailbox and to
//      point back at the same Cookie program.
//
// A new route the team deploys is therefore bridgeable as soon as it is enrolled, with no release of
// this server. A program anyone else deploys — even one pointing at the real mailbox — is never
// listed, because its upgrade authority is not the team's.
//
// The token account also carries everything the transfer needs (mailbox, IGP, decimals, the plugin's
// mint/escrow), so reading it replaces the per-route config the COOK-only bridge used to ship.
import { Connection, PublicKey, type ParsedAccountData } from "@solana/web3.js";

import {
  BRIDGE,
  BRIDGE_COOKIE_UPGRADE_AUTHORITY,
  BRIDGE_COOKIE_WARP_SEEDS,
  COOKIE_DOMAIN,
  SOLANA_DOMAIN,
} from "./config";
import { MIN_BRIDGE_COOK, getBridgeMinimum, type BridgeMinimum } from "./bridgeMinimum";
import { fetchTokens } from "./cookiescan";
import { CookieMcpError } from "./errors";
import { rawToUi, shortAddr } from "./format";
import { getConnection, getSolanaConnection } from "./rpc";

const BPF_UPGRADEABLE_LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const SEP = "-";

export type WarpType = "native" | "synthetic" | "collateral";
export type BridgeChain = "cookie" | "solana";

export const NATIVE_SYMBOL: Record<BridgeChain, string> = { cookie: "COOK", solana: "SOL" };

function pda(seeds: Array<string | Buffer>, programId: PublicKey): PublicKey {
  const seedBuffers = seeds.map((s) => (typeof s === "string" ? Buffer.from(s) : s));
  return PublicKey.findProgramAddressSync(seedBuffers, programId)[0];
}

/** The HyperlaneToken account of a warp program (the Sealevel token programs store their config at
 *  the message-recipient "account metas" PDA). */
export const deriveTokenPda = (warp: PublicKey) =>
  pda(["hyperlane_message_recipient", SEP, "handle", SEP, "account_metas"], warp);
export const deriveNativeCollateralPda = (warp: PublicKey) =>
  pda(["hyperlane_token", SEP, "native_collateral"], warp);
export const deriveEscrowPda = (warp: PublicKey) => pda(["hyperlane_token", SEP, "escrow"], warp);
export const deriveSyntheticMintPda = (warp: PublicKey) =>
  pda(["hyperlane_token", SEP, "mint"], warp);
/** The PDA a synthetic or collateral route pays from when it creates a recipient's token account on
 *  delivery. A plain system account with no data. */
export const deriveAtaPayerPda = (warp: PublicKey) =>
  pda(["hyperlane_token", SEP, "ata_payer"], warp);

// --- HyperlaneToken account layout -------------------------------------------------------------

export type IgpConfig =
  | { kind: "igp"; program: PublicKey; account: PublicKey }
  | { kind: "overheadIgp"; program: PublicKey; account: PublicKey };

export type WarpPlugin =
  | { type: "native" }
  | { type: "synthetic"; mint: PublicKey }
  | { type: "collateral"; tokenProgram: PublicKey; mint: PublicKey; escrow: PublicKey };

export interface HyperlaneTokenAccount {
  mailbox: PublicKey;
  /** This side's token decimals (what `transfer_remote` amounts and payouts are denominated in). */
  decimals: number;
  /** The decimals used inside the Hyperlane message, shared by both sides of the route. */
  remoteDecimals: number;
  owner: PublicKey | null;
  igp: IgpConfig | null;
  remoteRouters: Map<number, PublicKey>;
  plugin: WarpPlugin;
}

class Reader {
  off = 0;
  constructor(private readonly buf: Buffer) {}
  private need(n: number): void {
    if (this.off + n > this.buf.length) throw new Error("HyperlaneToken account is truncated");
  }
  u8(): number {
    this.need(1);
    return this.buf.readUInt8(this.off++);
  }
  u32(): number {
    this.need(4);
    const v = this.buf.readUInt32LE(this.off);
    this.off += 4;
    return v;
  }
  skip(n: number): void {
    this.need(n);
    this.off += n;
  }
  pubkey(): PublicKey {
    this.need(32);
    const pk = new PublicKey(this.buf.subarray(this.off, this.off + 32));
    this.off += 32;
    return pk;
  }
  option<T>(read: () => T): T | null {
    const tag = this.u8();
    if (tag === 0) return null;
    if (tag !== 1) throw new Error(`bad Option tag ${tag}`);
    return read();
  }
  get remaining(): number {
    return this.buf.length - this.off;
  }
}

/**
 * Decode a HyperlaneToken account (borsh, wrapped in the Sealevel AccountData header):
 *   initialized u8 · bump u8 · mailbox · mailbox_process_authority · dispatch_authority_bump u8
 *   · decimals u8 · remote_decimals u8 · owner Option<Pubkey> · ism Option<Pubkey>
 *   · igp Option<(Pubkey, enum { Igp(Pubkey), OverheadIgp(Pubkey) })>
 *   · destination_gas HashMap<u32,u64> · remote_routers HashMap<u32,H256> · plugin data.
 * The plugin is identified by what is left: native = collateral bump (1); synthetic = mint + mint
 * bump + ata-payer bump (34); collateral = token program + mint + escrow + two bumps (98).
 */
export function parseHyperlaneToken(data: Buffer): HyperlaneTokenAccount {
  const r = new Reader(data);
  if (r.u8() !== 1) throw new Error("HyperlaneToken account is not initialized");
  r.skip(1); // bump
  const mailbox = r.pubkey();
  r.skip(32); // mailbox_process_authority
  r.skip(1); // dispatch_authority_bump
  const decimals = r.u8();
  const remoteDecimals = r.u8();
  const owner = r.option(() => r.pubkey());
  r.option(() => r.pubkey()); // interchain_security_module
  const igp = r.option((): IgpConfig => {
    const program = r.pubkey();
    const tag = r.u8();
    const account = r.pubkey();
    if (tag === 0) return { kind: "igp", program, account };
    if (tag === 1) return { kind: "overheadIgp", program, account };
    throw new Error(`unknown IGP type ${tag}`);
  });
  const gasEntries = r.u32();
  r.skip(gasEntries * 12); // (u32 domain, u64 gas)
  const routerEntries = r.u32();
  const remoteRouters = new Map<number, PublicKey>();
  for (let i = 0; i < routerEntries; i++) {
    const domain = r.u32();
    remoteRouters.set(domain, r.pubkey());
  }

  let plugin: WarpPlugin;
  if (r.remaining === 1) {
    plugin = { type: "native" };
  } else if (r.remaining === 34) {
    plugin = { type: "synthetic", mint: r.pubkey() };
  } else if (r.remaining === 98) {
    const tokenProgram = r.pubkey();
    const mint = r.pubkey();
    const escrow = r.pubkey();
    plugin = { type: "collateral", tokenProgram, mint, escrow };
  } else {
    throw new Error(`unrecognised warp plugin data (${r.remaining} bytes)`);
  }
  return { mailbox, decimals, remoteDecimals, owner, igp, remoteRouters, plugin };
}

/** The plugin data must be the program's own PDAs; anything else means we misread the account. */
export function pluginMatchesProgram(plugin: WarpPlugin, warp: PublicKey): boolean {
  if (plugin.type === "synthetic") return plugin.mint.equals(deriveSyntheticMintPda(warp));
  if (plugin.type === "collateral") return plugin.escrow.equals(deriveEscrowPda(warp));
  return true;
}

// --- Routes ------------------------------------------------------------------------------------

export interface RouteSide {
  chain: BridgeChain;
  warp: PublicKey;
  type: WarpType;
  /** The SPL mint on this side, or null for the chain's native coin. */
  mint: PublicKey | null;
  /** Token program that owns `mint` (synthetic mints are always Token-2022). */
  tokenProgram: PublicKey | null;
  decimals: number;
  mailbox: PublicKey;
  igp: IgpConfig | null;
}

export interface BridgeRoute {
  symbol: string;
  name: string | null;
  cookie: RouteSide;
  solana: RouteSide;
}

const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

function sideFrom(chain: BridgeChain, warp: PublicKey, t: HyperlaneTokenAccount): RouteSide {
  const p = t.plugin;
  return {
    chain,
    warp,
    type: p.type,
    mint: p.type === "native" ? null : p.mint,
    tokenProgram:
      p.type === "collateral"
        ? p.tokenProgram
        : p.type === "synthetic"
          ? TOKEN_2022_PROGRAM_ID
          : null,
    decimals: t.decimals,
    mailbox: t.mailbox,
    igp: t.igp,
  };
}

/**
 * Pair a Cookie warp with the Solana warp its router names. Returns null — the pair is not a route —
 * unless both sides are on the expected mailboxes, they name each other, and each side's plugin data
 * is its own program's PDAs. Pure, so the whole trust check is unit-tested.
 */
export function pairRoute(args: {
  cookieWarp: PublicKey;
  cookieToken: HyperlaneTokenAccount;
  solanaWarp: PublicKey;
  solanaToken: HyperlaneTokenAccount;
  cookieMailbox: PublicKey;
  solanaMailbox: PublicKey;
}): { cookie: RouteSide; solana: RouteSide } | null {
  const { cookieWarp, cookieToken, solanaWarp, solanaToken } = args;
  if (!cookieToken.mailbox.equals(args.cookieMailbox)) return null;
  if (!solanaToken.mailbox.equals(args.solanaMailbox)) return null;
  if (!cookieToken.remoteRouters.get(SOLANA_DOMAIN)?.equals(solanaWarp)) return null;
  if (!solanaToken.remoteRouters.get(COOKIE_DOMAIN)?.equals(cookieWarp)) return null;
  if (!pluginMatchesProgram(cookieToken.plugin, cookieWarp)) return null;
  if (!pluginMatchesProgram(solanaToken.plugin, solanaWarp)) return null;
  // Both sides native would bridge COOK into SOL 1:1 — not a route anyone deploys; refuse it.
  if (cookieToken.plugin.type === "native" && solanaToken.plugin.type === "native") return null;
  return {
    cookie: sideFrom("cookie", cookieWarp, cookieToken),
    solana: sideFrom("solana", solanaWarp, solanaToken),
  };
}

/** Programs whose upgrade authority is `authority`. A programdata account is
 *  [u32 tag=3][u64 slot][u8 has_authority][authority 32] and a program account is
 *  [u32 tag=2][programdata 32], so both can be matched with a memcmp. */
async function programsWithAuthority(conn: Connection, authority: PublicKey): Promise<PublicKey[]> {
  const programData = await conn.getProgramAccounts(BPF_UPGRADEABLE_LOADER, {
    dataSlice: { offset: 0, length: 0 },
    filters: [{ memcmp: { offset: 13, bytes: authority.toBase58() } }],
  });
  const programs = await Promise.all(
    programData.map(({ pubkey }) =>
      conn.getProgramAccounts(BPF_UPGRADEABLE_LOADER, {
        dataSlice: { offset: 0, length: 0 },
        filters: [{ dataSize: 36 }, { memcmp: { offset: 4, bytes: pubkey.toBase58() } }],
      }),
    ),
  );
  return programs.flat().map((p) => p.pubkey);
}

/** Symbol from a Token-2022 mint's on-chain metadata extension, or null. */
async function token2022Meta(
  conn: Connection,
  mint: PublicKey,
): Promise<{ symbol: string; name: string } | null> {
  try {
    const info = await conn.getParsedAccountInfo(mint, "confirmed");
    const parsed = (info.value?.data as ParsedAccountData | undefined)?.parsed;
    const exts = (parsed?.info?.extensions ?? []) as Array<{
      extension: string;
      state?: { symbol?: string; name?: string };
    }>;
    const meta = exts.find((e) => e.extension === "tokenMetadata")?.state;
    return meta?.symbol ? { symbol: meta.symbol.trim(), name: (meta.name ?? "").trim() } : null;
  } catch {
    return null;
  }
}

async function labelRoute(
  sides: { cookie: RouteSide; solana: RouteSide },
  cookieConn: Connection,
  solanaConn: Connection,
): Promise<{ symbol: string; name: string | null }> {
  // A native side IS the asset (COOK on Cookie, SOL on Solana); otherwise ask the mints.
  for (const side of [sides.cookie, sides.solana]) {
    if (side.type === "native") return { symbol: NATIVE_SYMBOL[side.chain], name: null };
  }
  const cookieMint = sides.cookie.mint!;
  const fromCookie = await token2022Meta(cookieConn, cookieMint);
  if (fromCookie) return { symbol: fromCookie.symbol, name: fromCookie.name || null };
  const fromSolana = await token2022Meta(solanaConn, sides.solana.mint!);
  if (fromSolana) return { symbol: fromSolana.symbol, name: fromSolana.name || null };
  try {
    const t = (await fetchTokens()).find((x) => x.mint === cookieMint.toBase58());
    if (t?.metadata?.symbol) return { symbol: t.metadata.symbol, name: t.metadata.name ?? null };
  } catch {
    /* registry down — fall through to the address */
  }
  return { symbol: shortAddr(cookieMint.toBase58()), name: null };
}

async function discoverRoutes(): Promise<{ routes: BridgeRoute[]; warnings: string[] }> {
  const cookieConn = getConnection();
  const solanaConn = getSolanaConnection();
  const warnings: string[] = [];

  const candidates = new Map<string, PublicKey>();
  for (const s of BRIDGE_COOKIE_WARP_SEEDS) {
    try {
      const pk = new PublicKey(s);
      candidates.set(pk.toBase58(), pk);
    } catch {
      warnings.push(`ignored invalid Cookie warp program id "${s}"`);
    }
  }
  if (BRIDGE_COOKIE_UPGRADE_AUTHORITY) {
    try {
      const found = await programsWithAuthority(
        cookieConn,
        new PublicKey(BRIDGE_COOKIE_UPGRADE_AUTHORITY),
      );
      for (const pk of found) candidates.set(pk.toBase58(), pk);
    } catch (e) {
      warnings.push(
        `could not list Cookie Chain programs (${(e as Error).message}); only the built-in routes ` +
          "were checked, so a newly added token may be missing",
      );
    }
  }

  const cookieWarps = [...candidates.values()];
  const cookieInfos = await cookieConn.getMultipleAccountsInfo(
    cookieWarps.map(deriveTokenPda),
    "confirmed",
  );
  const cookieMailbox = new PublicKey(BRIDGE.cookie.mailbox);
  const solanaMailbox = new PublicKey(BRIDGE.solana.mailbox);

  const pending: Array<{
    cookieWarp: PublicKey;
    cookieToken: HyperlaneTokenAccount;
    solanaWarp: PublicKey;
  }> = [];
  cookieWarps.forEach((cookieWarp, i) => {
    const info = cookieInfos[i];
    if (!info || !info.owner.equals(cookieWarp)) return; // not a warp route (mailbox, IGP, ISM, …)
    let cookieToken: HyperlaneTokenAccount;
    try {
      cookieToken = parseHyperlaneToken(info.data);
    } catch {
      return;
    }
    const solanaWarp = cookieToken.remoteRouters.get(SOLANA_DOMAIN);
    if (solanaWarp && cookieToken.mailbox.equals(cookieMailbox)) {
      pending.push({ cookieWarp, cookieToken, solanaWarp });
    }
  });
  if (!pending.length) return { routes: [], warnings };

  const solanaInfos = await solanaConn.getMultipleAccountsInfo(
    pending.map((p) => deriveTokenPda(p.solanaWarp)),
    "confirmed",
  );
  const routes: BridgeRoute[] = [];
  for (let i = 0; i < pending.length; i++) {
    const { cookieWarp, cookieToken, solanaWarp } = pending[i];
    const info = solanaInfos[i];
    if (!info || !info.owner.equals(solanaWarp)) {
      warnings.push(
        `Cookie warp ${cookieWarp.toBase58()} names a Solana router with no warp route`,
      );
      continue;
    }
    let solanaToken: HyperlaneTokenAccount;
    try {
      solanaToken = parseHyperlaneToken(info.data);
    } catch (e) {
      warnings.push(`Solana warp ${solanaWarp.toBase58()}: ${(e as Error).message}`);
      continue;
    }
    const sides = pairRoute({
      cookieWarp,
      cookieToken,
      solanaWarp,
      solanaToken,
      cookieMailbox,
      solanaMailbox,
    });
    if (!sides) {
      warnings.push(
        `Cookie warp ${cookieWarp.toBase58()} and Solana warp ${solanaWarp.toBase58()} do not form ` +
          "a consistent route (mailbox, routers or plugin accounts disagree) — skipped",
      );
      continue;
    }
    // Collateral mints can be classic SPL or Token-2022; the plugin data names the program, but the
    // mint's owner is the ground truth for ATAs.
    for (const side of [sides.cookie, sides.solana]) {
      if (side.type !== "collateral" || !side.mint) continue;
      const conn = side.chain === "cookie" ? cookieConn : solanaConn;
      const mintInfo = await conn.getAccountInfo(side.mint, "confirmed");
      if (mintInfo) side.tokenProgram = mintInfo.owner;
    }
    const label = await labelRoute(sides, cookieConn, solanaConn);
    routes.push({ ...label, ...sides });
  }
  routes.sort((a, b) => a.symbol.localeCompare(b.symbol));
  return { routes, warnings };
}

const CACHE_TTL_MS = 10 * 60_000;
let cache: { at: number; value: Promise<{ routes: BridgeRoute[]; warnings: string[] }> } | null =
  null;

/** Every bridgeable token, discovered on-chain and cached for 10 minutes. A failed discovery is not
 *  cached, so the next call retries. */
export async function getBridgeRoutes(): Promise<{ routes: BridgeRoute[]; warnings: string[] }> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;
  const value = discoverRoutes();
  cache = { at: Date.now(), value };
  try {
    return await value;
  } catch (e) {
    cache = null;
    throw e;
  }
}

/** Test hook: forget discovered routes. */
export function clearBridgeRouteCache(): void {
  cache = null;
}

/**
 * Pick the route for `query`: a symbol (case-insensitive) or the mint of either side. Pure, so the
 * matching rules are tested without a cluster. The native coin has no mint of its own on either side
 * (cookie-mcp's So111… means COOK on Cookie but wSOL on Solana), so a native asset is matched by
 * symbol only.
 */
export function matchRoute(routes: BridgeRoute[], query: string): BridgeRoute {
  const q = query.trim();
  const byMint = routes.filter(
    (r) => r.cookie.mint?.toBase58() === q || r.solana.mint?.toBase58() === q,
  );
  const matches = byMint.length
    ? byMint
    : routes.filter((r) => r.symbol.toLowerCase() === q.toLowerCase());
  const known = routes.map((r) => r.symbol).join(", ") || "none found";
  if (!matches.length) {
    throw new CookieMcpError(
      `no bridge route for token "${query}"`,
      `bridgeable tokens: ${known}. Pass a symbol or the token's mint on either chain; ` +
        "get_bridge_tokens lists them with their mints",
    );
  }
  if (matches.length > 1) {
    throw new CookieMcpError(
      `"${query}" matches ${matches.length} bridge routes`,
      "pass the token's mint instead: " +
        matches
          .map((r) => `${r.symbol} ${(r.cookie.mint ?? r.solana.mint)!.toBase58()}`)
          .join("; "),
    );
  }
  return matches[0];
}

export async function resolveBridgeToken(query: string): Promise<BridgeRoute> {
  const { routes } = await getBridgeRoutes();
  return matchRoute(routes, query);
}

// --- Tool: get_bridge_tokens ------------------------------------------------------------------

function describeSide(side: RouteSide) {
  return {
    warpProgram: side.warp.toBase58(),
    type: side.type,
    asset:
      side.type === "native"
        ? `native ${NATIVE_SYMBOL[side.chain]}`
        : side.type === "synthetic"
          ? "minted on arrival, burned on departure"
          : "locked in the route's escrow",
    mint: side.mint?.toBase58() ?? null,
    decimals: side.decimals,
  };
}

export async function getBridgeTokens() {
  const { routes, warnings } = await getBridgeRoutes();
  // Sequential: the keyless Jupiter tier allows 0.5 req/s, and minimums are cached for 5 minutes.
  const minimums: Array<BridgeMinimum | null> = [];
  for (const r of routes) minimums.push(await getBridgeMinimum(r).catch(() => null));
  return {
    count: routes.length,
    tokens: routes.map((r, i) => {
      const min = minimums[i];
      return {
        symbol: r.symbol,
        name: r.name,
        minimum: min
          ? { amount: rawToUi(min.raw, min.decimals), worthCook: MIN_BRIDGE_COOK, basis: min.basis }
          : null,
        cookie: describeSide(r.cookie),
        solana: describeSide(r.solana),
      };
    }),
    ...(warnings.length ? { warnings } : {}),
    note:
      "Discovered on-chain from the Cookie bridge's warp programs, so a newly added token appears here " +
      "as soon as its route is enrolled. Pass `symbol` (or a mint) as `token` to bridge. `minimum` is " +
      `the smallest transfer bridge accepts: the amount worth ${MIN_BRIDGE_COOK} COOK right now ` +
      "(null = no price found; the minimum is then not enforced).",
  };
}
