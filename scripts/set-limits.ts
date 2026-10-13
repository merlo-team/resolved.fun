/**
 * Set the SOL pool's safety limits. Admin-only on-chain; signs with keys/deployer.json.
 *
 *   ../node_modules/.bin/tsx scripts/set-limits.ts --max-pot 0 --entries-per-day 0
 *
 * --max-pot           largest pot one round may hold, in SOL (0 = no cap, needed for unlimited arena seats)
 * --entries-per-day   games one wallet may enter per day (0 = no cap)
 */
import * as anchor from "@coral-xyz/anchor";
import { NATIVE_MINT } from "@solana/spl-token";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { rpcHttp } from "./rpc.js";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const maxPot = arg("max-pot");
const perDay = arg("entries-per-day");
if (maxPot === undefined && perDay === undefined) throw new Error("usage: --max-pot <sol> and/or --entries-per-day <n>");

const cluster = process.env.SOLANA_CLUSTER === "mainnet" ? "mainnet" : "devnet";
const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(new URL("../keys/deployer.json", import.meta.url), "utf8"))));
const idl = JSON.parse(readFileSync(new URL("../target/idl/resolved_pool.json", import.meta.url), "utf8"));
const conn = new Connection(rpcHttp(cluster), "confirmed");
const program = new anchor.Program(idl, new anchor.AnchorProvider(conn, new anchor.Wallet(admin), { commitment: "confirmed" }));
const [config] = PublicKey.findProgramAddressSync([Buffer.from("config"), NATIVE_MINT.toBuffer()], program.programId);

const update = {
  admin: null,
  oracle: null,
  treasury: null,
  rakeBps: null,
  maxEntriesPerDay: perDay === undefined ? null : Number(perDay),
  maxPot: maxPot === undefined ? null : new anchor.BN(Math.round(Number(maxPot) * LAMPORTS_PER_SOL)),
  paused: null,
};
const sig = await program.methods.updateConfig(update).accountsPartial({ admin: admin.publicKey, config }).rpc();
const state = await (program.account as any).config.fetch(config);
console.log(`max pot: ${state.maxPot.isZero() ? "no cap" : `${state.maxPot.toNumber() / LAMPORTS_PER_SOL} SOL`} · entries/day: ${state.maxEntriesPerDay || "no cap"}`);
console.log("tx", sig);
