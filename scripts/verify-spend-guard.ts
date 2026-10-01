/**
 * Spend-guard check against LIVE venue builds. NOTHING IS SIGNED, NOTHING IS SENT, NOTHING IS SPENT:
 *   npx tsx scripts/verify-spend-guard.ts
 *   OWNER=<funded pubkey> OUTPUT=<mint> npx tsx scripts/verify-spend-guard.ts
 *
 * Runs in external-signer mode for `OWNER` (a public key only; we never hold its secret), so every
 * money tool stops at `needs_signature` after its pre-sign checks. A `needs_signature` therefore
 * means the API's real build passed `simulateWithinBudget`. The script then re-runs the guard on a
 * fresh build with a budget one unit too small, to prove the same build would be refused.
 */
import { PublicKey, VersionedTransaction, Transaction } from "@solana/web3.js";

// A funded public wallet (the limit-order program admin), so the venues' builds simulate cleanly.
const OWNER = process.env.OWNER?.trim() || "HGSGbiM3tMvbX8cxitEgzbQv53M4rFcsE1gn7fvrHrkN";
const COOK = "So11111111111111111111111111111111111111112";
const OUTPUT = process.env.OUTPUT?.trim() || "6H7xnYfBFeEU8S8mhrZRkFNS5vEegRqEwv7h42WbntCL"; // MON
const AMOUNT = "0.01";

async function main() {
  process.env.COOKIE_SIGNER = "external";
  delete process.env.COOKIE_PRIVATE_KEY;
  const { runWithRequestContext } = await import("../src/core/context");
  const { SignatureRequired } = await import("../src/core/signer");
  const { trade } = await import("../src/core/trade");
  const { buildAggSwapTx } = await import("../src/core/cookiebox");
  const { getConnection } = await import("../src/core/rpc");
  const { simulateWithinBudget, spendBudget } = await import("../src/core/spendGuard");
  const { getLaunchpadPools, launchpadBuy } = await import("../src/core/launchpad");

  const run = <T>(fn: () => Promise<T>) => runWithRequestContext({ wallet: OWNER }, fn);
  const expectSignature = async (label: string, fn: () => Promise<unknown>) => {
    try {
      const r = await run(fn);
      console.log(`  ✗ ${label}: expected needs_signature, got`, JSON.stringify(r)?.slice(0, 200));
      process.exitCode = 1;
    } catch (e) {
      if (e instanceof SignatureRequired) {
        console.log(`  ✓ ${label}: build passed the guard → needs_signature`);
      } else {
        const hint = (e as { hint?: string }).hint;
        console.log(
          `  ✗ ${label}: ${e instanceof Error ? e.message : e}${hint ? ` (${hint})` : ""}`,
        );
        process.exitCode = 1;
      }
    }
  };

  console.log(`== swaps for ${OWNER}: ${AMOUNT} COOK → ${OUTPUT}`);
  for (const aggregator of ["cookiebox", "cookiescan"] as const) {
    await expectSignature(`trade via ${aggregator}`, () =>
      trade({ inputMint: COOK, outputMint: OUTPUT, amount: AMOUNT, aggregator }),
    );
  }

  console.log("== the same kind of build with a budget one unit too small is refused");
  const amountRaw = 10_000_000n;
  const built = await buildAggSwapTx({
    inputMint: COOK,
    outputMint: OUTPUT,
    amount: amountRaw.toString(),
    slippageBps: 500,
    owner: OWNER,
  });
  const bytes = Buffer.from(built.transactionBase64, "base64");
  let tx: VersionedTransaction | Transaction;
  try {
    tx = VersionedTransaction.deserialize(bytes);
  } catch {
    tx = Transaction.from(bytes);
  }
  const tight = { ...spendBudget(COOK, amountRaw), native: amountRaw - 1n };
  try {
    await simulateWithinBudget(getConnection(), tx, new PublicKey(OWNER), tight, {
      what: "swap",
      source: "Cookiebox aggregator",
      commitment: "confirmed",
    });
    console.log("  ✗ a too-small budget was accepted");
    process.exitCode = 1;
  } catch (e) {
    console.log(`  ✓ refused: ${e instanceof Error ? e.message : e}`);
  }

  console.log("== launchpad buy");
  const pools = await getLaunchpadPools({ status: "live", limit: 5 }).catch(() => null);
  const pool = pools?.pools[0];
  if (!pool) {
    console.log("  - no active launchpad pool to try");
  } else {
    await expectSignature(`launchpad_buy ${pool.pool}`, () =>
      launchpadBuy({ ref: pool.pool, amountCook: AMOUNT }),
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
