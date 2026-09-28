/**
 * Bridge route check. Spends NOTHING and needs no key: it discovers every bridge route on-chain, then
 * for each token and direction builds a real transfer_remote for a wallet that holds the source asset
 * and simulates it with signature verification off. A simulation that dispatches proves the account
 * layout (plugin, IGP, PDAs) is exactly what the live warp program expects.
 *   npx tsx scripts/verify-bridge.ts
 * The public Solana RPC rate-limits the holder lookups; VERIFY_BRIDGE_SENDERS=<addr>,<addr> names
 * wallets to try first when a direction reports no funded holder.
 * Expected: every token lists both sides, and every direction prints "✓ dispatches".
 */
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";

import { buildTransferRemoteIx, routeFor, type BridgeDirection } from "../src/core/bridge";
import { getBridgeRoutes, type RouteSide } from "../src/core/bridgeRoutes";
import { uiToRaw } from "../src/core/format";
import { ownPublicKey } from "../src/core/wallet";

const DIRECTIONS: BridgeDirection[] = ["cookie-to-solana", "solana-to-cookie"];
/** Lamports a sender needs beyond the amount: the IGP payment, the dispatched-message rent, fees. */
const LAMPORT_HEADROOM = 20_000_000;

/** Wallets that recently sent a tx to this warp program — people bridging out of this side, so they
 *  held the asset — plus the largest holders of a token side where the RPC serves that index call. */
async function candidateSenders(conn: Connection, side: RouteSide): Promise<PublicKey[]> {
  // VERIFY_BRIDGE_SENDERS (comma-separated) and the configured wallet first — public keys only,
  // nothing here signs — then anyone else we can find.
  const own = ownPublicKey();
  const listed = (process.env.VERIFY_BRIDGE_SENDERS ?? "").split(",").map((x) => x.trim());
  const out: PublicKey[] = [...listed, own ?? ""].filter(Boolean).map((x) => new PublicKey(x));
  if (side.mint) {
    try {
      const largest = await conn.getTokenLargestAccounts(side.mint, "confirmed");
      for (const a of largest.value.slice(0, 10)) {
        const info = await conn.getParsedAccountInfo(a.address, "confirmed");
        const owner = (info.value?.data as { parsed?: { info?: { owner?: string } } })?.parsed?.info
          ?.owner;
        if (owner) out.push(new PublicKey(owner));
      }
    } catch {
      /* index method refused (paid-plan gate or rate limit) — recent senders below still work */
    }
  }
  try {
    const sigs = await conn.getSignaturesForAddress(side.warp, { limit: 10 });
    for (const s of sigs) {
      if (s.err) continue;
      await new Promise((r) => setTimeout(r, 400)); // the public Solana RPC rate-limits this hard
      const tx = await conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 });
      const payer = tx?.transaction.message.staticAccountKeys[0];
      if (payer) out.push(payer);
    }
  } catch {
    /* index method refused — use whatever candidates we already have */
  }
  return out;
}

/** A wallet (on-curve, so a person, not a PDA) that holds `amount` of the source asset plus fees. */
async function findSender(
  conn: Connection,
  side: RouteSide,
  amount: bigint,
): Promise<PublicKey | null> {
  const need = BigInt(LAMPORT_HEADROOM) + (side.type === "native" ? amount : 0n);
  const seen = new Set<string>();
  for (const pk of await candidateSenders(conn, side)) {
    if (seen.has(pk.toBase58()) || !PublicKey.isOnCurve(pk.toBytes())) continue;
    seen.add(pk.toBase58());
    if (BigInt(await conn.getBalance(pk, "confirmed")) < need) continue;
    if (side.mint) {
      const accts = await conn.getParsedTokenAccountsByOwner(pk, { mint: side.mint }, "confirmed");
      const held = accts.value.reduce(
        (sum, { account }) =>
          sum +
          BigInt(
            (account.data as { parsed: { info: { tokenAmount: { amount: string } } } }).parsed.info
              .tokenAmount.amount,
          ),
        0n,
      );
      if (held < amount) continue;
    }
    return pk;
  }
  return null;
}

async function main(): Promise<void> {
  const { routes, warnings } = await getBridgeRoutes();
  for (const w of warnings) console.log(`  ! ${w}`);
  console.log(`discovered ${routes.length} bridge routes`);

  for (const token of routes) {
    console.log(`\n${token.symbol}`);
    for (const side of [token.cookie, token.solana]) {
      console.log(
        `  ${side.chain.padEnd(6)} ${side.type.padEnd(10)} warp ${side.warp.toBase58()} ` +
          `mint ${side.mint?.toBase58() ?? "(native)"} dec ${side.decimals} igp ${side.igp?.kind ?? "none"}`,
      );
    }
    for (const direction of DIRECTIONS) {
      const route = routeFor(token, direction);
      const amount = uiToRaw("0.01", route.source.decimals);
      const sender = await findSender(route.sourceConn, route.source, amount);
      if (!sender) {
        console.log(`  – ${direction}: no funded holder found to simulate with — skipped`);
        continue;
      }
      const uniqueMsg = Keypair.generate();
      const ix = await buildTransferRemoteIx(
        route,
        sender,
        uniqueMsg.publicKey,
        sender.toBytes(),
        amount,
      );
      const { blockhash } = await route.sourceConn.getLatestBlockhash("confirmed");
      const tx = new Transaction({ feePayer: sender, recentBlockhash: blockhash })
        .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }))
        .add(ix);
      const vtx = new VersionedTransaction(tx.compileMessage());
      try {
        const sim = await route.sourceConn.simulateTransaction(vtx, {
          sigVerify: false,
          replaceRecentBlockhash: true,
          commitment: "confirmed",
        });
        const logs = sim.value.logs ?? [];
        if (sim.value.err) {
          console.log(`  ✗ ${direction}: ${JSON.stringify(sim.value.err)}`);
          for (const l of logs.slice(-6)) console.log(`      ${l}`);
          process.exitCode = 1;
        } else {
          const dispatched = logs.find((l) => /Dispatched message/i.test(l));
          console.log(
            `  ✓ ${direction}: dispatches (sender ${sender.toBase58()}, ` +
              `${sim.value.unitsConsumed} CU)${dispatched ? "" : " — no dispatch log seen"}`,
          );
        }
      } catch (e) {
        console.log(
          `  ? ${direction}: the RPC refused the simulate call (${(e as Error).message})`,
        );
      }
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
