/**
 * Set (or change) the creator fee for the SOL pool. Admin-only on-chain; signs with keys/deployer.json.
 *
 *   ../node_modules/.bin/tsx scripts/set-fees.ts --bps 100 --to 6PQ9ULgtZnsvCsTRinDRdiVaHayuAykn15Do5WSMBKm7
 *
 * --bps  creator fee in basis points (100 = 1%). House rake + creator fee must stay ≤ 20%.
 * --to   wallet credited with the fee: it accrues in that wallet's in-game balance on resolved.fun
 *        and is withdrawn as plain SOL from the site's wallet window.
 */
import * as anchor from "@coral-xyz/anchor";
import { NATIVE_MINT } from "@solana/spl-token";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { rpcHttp } from "./rpc.js";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const bps = Number(arg("bps"));
const to = arg("to");
if (!Number.isInteger(bps) || bps < 0 || !to) throw new Error("usage: --bps <int> --to <wallet>");

const cluster = process.env.SOLANA_CLUSTER === "mainnet" ? "mainnet" : "devnet";
const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(new URL("../keys/deployer.json", import.meta.url), "utf8"))));
const idl = JSON.parse(readFileSync(new URL("../target/idl/resolved_pool.json", import.meta.url), "utf8"));
const conn = new Connection(rpcHttp(cluster), "confirmed");
const program = new anchor.Program(idl, new anchor.AnchorProvider(conn, new anchor.Wallet(admin), { commitment: "confirmed" }));

const mint = NATIVE_MINT;
const [config] = PublicKey.findProgramAddressSync([Buffer.from("config"), mint.toBuffer()], program.programId);
const [fees] = PublicKey.findProgramAddressSync([Buffer.from("fees"), mint.toBuffer()], program.programId);
const creator = new PublicKey(to);

const exists = await conn.getAccountInfo(fees);
const sig = exists
  ? await program.methods.updateFees(bps, creator).accountsPartial({ admin: admin.publicKey, config, fees }).rpc()
  : await program.methods.initFees(bps, creator).accountsPartial({ admin: admin.publicKey, config, fees, systemProgram: SystemProgram.programId }).rpc();

const state = await (program.account as any).fees.fetch(fees);
console.log(`${exists ? "updated" : "initialised"} creator fee: ${state.creatorBps / 100}% → ${state.creator.toBase58()} (credited to its in-game balance)`);
console.log("tx", sig);
