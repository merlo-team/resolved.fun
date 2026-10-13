/**
 * Set the SOL pool's fees by table size. Admin-only on-chain; signs with keys/deployer.json.
 * Set SOLANA_CLUSTER=mainnet (and QUICKNODE_RPC_URL) for mainnet.
 *
 *   ../node_modules/.bin/tsx --env-file=../server/.env scripts/set-fee-tiers.ts --rake 0 --base 100 --tier 5:200 --tier 10:500
 *
 * --rake   house rake to the treasury, in bps (omit to leave it as is; 0 = the creator fee is the only fee)
 * --base   creator fee for tables below every tier, in bps (100 = 1%)
 * --tier   players:bps, up to two: a round with at least that many players pays that fee
 *
 * Also upgrades a Fees account from before tiers existed (the program grows it in place).
 */
import * as anchor from "@coral-xyz/anchor";
import { NATIVE_MINT } from "@solana/spl-token";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { rpcHttp } from "./rpc.js";

const args = process.argv.slice(2);
const one = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const tiers = args.flatMap((a, i) => (a === "--tier" ? [args[i + 1]] : [])).map((t) => {
  const [players, bps] = t.split(":").map(Number);
  if (!(players >= 2) || !(bps >= 0)) throw new Error(`bad --tier ${t} (use players:bps, e.g. 5:200)`);
  return { players, bps };
});
const base = one("base");
if (base === undefined || tiers.length > 2) throw new Error("usage: --base <bps> [--tier players:bps]x2 [--rake bps]");
while (tiers.length < 2) tiers.push({ players: 0, bps: 0 });

const cluster = process.env.SOLANA_CLUSTER === "mainnet" ? "mainnet" : "devnet";
const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(new URL("../keys/deployer.json", import.meta.url), "utf8"))));
const idl = JSON.parse(readFileSync(new URL("../target/idl/resolved_pool.json", import.meta.url), "utf8"));
const conn = new Connection(rpcHttp(cluster), "confirmed");
const program = new anchor.Program(idl, new anchor.AnchorProvider(conn, new anchor.Wallet(admin), { commitment: "confirmed" }));
const [config] = PublicKey.findProgramAddressSync([Buffer.from("config"), NATIVE_MINT.toBuffer()], program.programId);
const [fees] = PublicKey.findProgramAddressSync([Buffer.from("fees"), NATIVE_MINT.toBuffer()], program.programId);

if (one("rake") !== undefined) {
  const sig = await program.methods
    .updateConfig({ admin: null, oracle: null, treasury: null, rakeBps: Number(one("rake")), maxEntriesPerDay: null, maxPot: null, paused: null })
    .accountsPartial({ admin: admin.publicKey, config })
    .rpc();
  console.log("rake tx", sig);
}
const sig = await program.methods
  .setFeeTiers(Number(base), tiers.map((t) => t.players), tiers.map((t) => t.bps))
  .accountsPartial({ admin: admin.publicKey, config, fees, systemProgram: SystemProgram.programId })
  .rpc();
console.log("tiers tx", sig);

const cfg = await (program.account as any).config.fetch(config);
const f = await (program.account as any).fees.fetch(fees);
const pct = (bps: number) => `${(cfg.rakeBps + bps) / 100}%`;
const steps = [`below ${f.tierPlayers.find((p: number) => p > 0) ?? "∞"} players: ${pct(f.creatorBps)}`];
f.tierPlayers.forEach((p: number, i: number) => p > 0 && steps.push(`${p}+ players: ${pct(f.tierBps[i])}`));
console.log(`house rake ${cfg.rakeBps / 100}% · total fee ${steps.join(" · ")}`);
