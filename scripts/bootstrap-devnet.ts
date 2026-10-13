/**
 * Devnet pool setup, one pool per currency: treasury, program Config + vault for that mint,
 * oracle funding. Idempotent: re-running skips whatever already exists. Writes devnet.json.
 *
 *   ../node_modules/.bin/tsx scripts/bootstrap-devnet.ts sol    # wrapped-SOL pool
 *   ../node_modules/.bin/tsx scripts/bootstrap-devnet.ts usdc   # test-USDC pool (creates the mint)
 */
import * as anchor from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import { createMint, getOrCreateAssociatedTokenAccount, NATIVE_MINT, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, sendAndConfirmTransaction, SystemProgram, Transaction } from "@solana/web3.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const RPC = "https://api.devnet.solana.com";
const OUT = new URL("../devnet.json", import.meta.url);
const CURRENCY = (process.argv[2] ?? "sol").toLowerCase() as "sol" | "usdc";
const RAKE_BPS = 800;
// 0 = no cap. Limits can be set later with scripts/set-limits.ts.
const MAX_ENTRIES_PER_DAY = 0;
const MAX_POT = 0;

const load = (path: string) =>
  Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"))));

const deployer = load("../keys/deployer.json");
const oracle = load("../keys/oracle.json");
const idl = JSON.parse(readFileSync(new URL("../target/idl/resolved_pool.json", import.meta.url), "utf8"));

const conn = new Connection(RPC, "confirmed");
const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(deployer), { commitment: "confirmed" });
const program = new anchor.Program(idl, provider);

const saved = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : {};

let mint: PublicKey;
if (CURRENCY === "sol") {
  mint = NATIVE_MINT;
} else if (saved.pools?.usdc?.mint ?? saved.usdcMint) {
  mint = new PublicKey(saved.pools?.usdc?.mint ?? saved.usdcMint);
  console.log("mint (existing)", mint.toBase58());
} else {
  mint = await createMint(conn, deployer, deployer.publicKey, null, 6);
  console.log("mint created", mint.toBase58());
}

const treasury = await getOrCreateAssociatedTokenAccount(conn, deployer, mint, deployer.publicKey);
const [config] = PublicKey.findProgramAddressSync([Buffer.from("config"), mint.toBuffer()], program.programId);
const [vault] = PublicKey.findProgramAddressSync([Buffer.from("vault"), mint.toBuffer()], program.programId);

if (await conn.getAccountInfo(config)) {
  console.log("config (existing)", config.toBase58());
} else {
  await program.methods
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
  console.log("config initialised", config.toBase58());
}

// The oracle pays rent for rounds and sponsors users' transaction fees.
const oracleBalance = await conn.getBalance(oracle.publicKey);
if (oracleBalance < 0.5 * LAMPORTS_PER_SOL) {
  const tx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: oracle.publicKey, lamports: 0.6 * LAMPORTS_PER_SOL }),
  );
  await sendAndConfirmTransaction(conn, tx, [deployer]);
  console.log("oracle funded with 0.6 SOL");
}

const pool = {
  mint: mint.toBase58(),
  decimals: CURRENCY === "sol" ? 9 : 6,
  treasury: treasury.address.toBase58(),
  config: config.toBase58(),
  vault: vault.toBase58(),
  rakeBps: RAKE_BPS,
  maxEntriesPerDay: MAX_ENTRIES_PER_DAY,
  maxPot: MAX_POT,
};
const out = {
  cluster: "devnet",
  rpc: RPC,
  programId: program.programId.toBase58(),
  oracle: oracle.publicKey.toBase58(),
  admin: deployer.publicKey.toBase58(),
  pools: { ...(saved.pools ?? {}), [CURRENCY]: pool },
};
writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
console.log(out);
