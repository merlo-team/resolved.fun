/**
 * Mainnet pool bootstrap: treasury ATA, Config + vault, fees/tiers, oracle funding.
 * Idempotent. Writes mainnet.json.
 *
 *   QUICKNODE_RPC_URL=… ../node_modules/.bin/tsx scripts/bootstrap-mainnet.ts
 *
 * Matches prod intent: house rake 0, creator 1% / 2%@5+ / 5%@10+ → 6PQ9…
 */
import * as anchor from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import { getOrCreateAssociatedTokenAccount, NATIVE_MINT, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  sendAndConfirmTransaction,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { rpcHttp } from "./rpc.js";

const CREATOR = new PublicKey("6PQ9ULgtZnsvCsTRinDRdiVaHayuAykn15Do5WSMBKm7");
const RAKE_BPS = 0;
const CREATOR_BPS = 100;
const TIER_PLAYERS: [number, number] = [5, 10];
const TIER_BPS: [number, number] = [200, 500];
const MAX_ENTRIES_PER_DAY = 0;
const MAX_POT = 0;
const ORACLE_MIN_SOL = 0.5;
const ORACLE_FUND_SOL = 0.6;

const OUT = new URL("../mainnet.json", import.meta.url);
const rpc = rpcHttp("mainnet");

const load = (path: string) =>
  Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"))));

const deployer = load("../keys/deployer.json");
const oracle = load("../keys/oracle.json");
const idl = JSON.parse(readFileSync(new URL("../target/idl/resolved_pool.json", import.meta.url), "utf8"));

const conn = new Connection(rpc, "confirmed");
const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(deployer), { commitment: "confirmed" });
const program = new anchor.Program(idl, provider);

const mint = NATIVE_MINT;
const treasury = await getOrCreateAssociatedTokenAccount(conn, deployer, mint, deployer.publicKey);
const [config] = PublicKey.findProgramAddressSync([Buffer.from("config"), mint.toBuffer()], program.programId);
const [vault] = PublicKey.findProgramAddressSync([Buffer.from("vault"), mint.toBuffer()], program.programId);
const [fees] = PublicKey.findProgramAddressSync([Buffer.from("fees"), mint.toBuffer()], program.programId);

if (await conn.getAccountInfo(config)) {
  console.log("config (existing)", config.toBase58());
} else {
  const sig = await program.methods
    .initConfig(oracle.publicKey, RAKE_BPS, MAX_ENTRIES_PER_DAY, new BN(MAX_POT))
    .accountsPartial({
      admin: deployer.publicKey,
      config,
      mint,
      treasury: treasury.address,
      vault,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  console.log("config initialised", config.toBase58(), sig);
}

if (await conn.getAccountInfo(fees)) {
  console.log("fees (existing)", fees.toBase58());
} else {
  const sig = await program.methods
    .initFees(CREATOR_BPS, CREATOR)
    .accountsPartial({ admin: deployer.publicKey, config, fees, systemProgram: SystemProgram.programId })
    .rpc();
  console.log("fees initialised", fees.toBase58(), sig);
}

{
  const sig = await program.methods
    .setFeeTiers(CREATOR_BPS, TIER_PLAYERS, TIER_BPS)
    .accountsPartial({ admin: deployer.publicKey, config, fees, systemProgram: SystemProgram.programId })
    .rpc();
  console.log("fee tiers set", sig);
}

const oracleBalance = await conn.getBalance(oracle.publicKey);
if (oracleBalance < ORACLE_MIN_SOL * LAMPORTS_PER_SOL) {
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: deployer.publicKey,
      toPubkey: oracle.publicKey,
      lamports: Math.round(ORACLE_FUND_SOL * LAMPORTS_PER_SOL),
    }),
  );
  const sig = await sendAndConfirmTransaction(conn, tx, [deployer]);
  console.log(`oracle funded with ${ORACLE_FUND_SOL} SOL`, sig);
} else {
  console.log("oracle balance ok", oracleBalance / LAMPORTS_PER_SOL);
}

const out = {
  cluster: "mainnet",
  rpc: "https://api.mainnet-beta.solana.com",
  programId: program.programId.toBase58(),
  oracle: oracle.publicKey.toBase58(),
  admin: deployer.publicKey.toBase58(),
  pools: {
    sol: {
      mint: mint.toBase58(),
      decimals: 9,
      treasury: treasury.address.toBase58(),
      config: config.toBase58(),
      vault: vault.toBase58(),
      fees: fees.toBase58(),
      rakeBps: RAKE_BPS,
      creatorBps: CREATOR_BPS,
      creator: CREATOR.toBase58(),
      tierPlayers: TIER_PLAYERS,
      tierBps: TIER_BPS,
      maxEntriesPerDay: MAX_ENTRIES_PER_DAY,
      maxPot: MAX_POT,
    },
  },
};
writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
console.log(out);
console.log("deployer SOL left", (await conn.getBalance(deployer.publicKey)) / LAMPORTS_PER_SOL);
console.log("oracle SOL", (await conn.getBalance(oracle.publicKey)) / LAMPORTS_PER_SOL);
if (existsSync(OUT)) console.log("wrote", OUT.pathname);
