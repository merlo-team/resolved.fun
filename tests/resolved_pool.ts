import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import {
  createAssociatedTokenAccount,
  createMint,
  getAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram } from "@solana/web3.js";
import { expect } from "chai";
import { ResolvedPool } from "../target/types/resolved_pool";

const USDC = 1_000_000; // 6 decimals
const RAKE_BPS = 800;
const CREATOR_BPS = 100;
/** What winners split: pot minus house rake and creator fee (each floored separately, like the program). */
const distributableOf = (pot: number) => pot - Math.floor((pot * RAKE_BPS) / 10_000) - Math.floor((pot * CREATOR_BPS) / 10_000);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = () => Math.floor(Date.now() / 1000);

async function expectError(promise: Promise<unknown>, code: string) {
  try {
    await promise;
  } catch (err) {
    expect(String(err)).to.include(code);
    return;
  }
  expect.fail(`expected ${code}`);
}

describe("resolved_pool", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.ResolvedPool as Program<ResolvedPool>;
  const conn = provider.connection;
  const admin = (provider.wallet as anchor.Wallet).payer;

  const oracle = Keypair.generate();
  const users = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
  let mint: PublicKey;
  let treasury: PublicKey;
  const creator = Keypair.generate();
  let feesPda: PublicKey;
  const userTokens: PublicKey[] = [];
  let nextRoundId = 1;

  // Every pool account is seeded by its currency mint, so these resolve once the mint exists.
  let configPda: PublicKey;
  let vaultPda: PublicKey;
  const playerPda = (user: PublicKey) =>
    PublicKey.findProgramAddressSync([Buffer.from("player"), mint.toBuffer(), user.toBuffer()], program.programId)[0];
  const roundPda = (id: number) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("round"), new BN(id).toArrayLike(Buffer, "le", 8)],
      program.programId,
    )[0];
  const entryPda = (round: PublicKey, user: PublicKey) =>
    PublicKey.findProgramAddressSync([Buffer.from("entry"), round.toBuffer(), user.toBuffer()], program.programId)[0];

  const balanceOf = async (user: PublicKey) => (await program.account.player.fetch(playerPda(user))).balance.toNumber();

  async function airdrop(to: PublicKey) {
    const sig = await conn.requestAirdrop(to, 2 * LAMPORTS_PER_SOL);
    await conn.confirmTransaction(sig, "confirmed");
  }

  function deposit(user: Keypair, index: number, amount: number) {
    return program.methods
      .deposit(new BN(amount))
      .accountsPartial({
        user: user.publicKey,
        payer: admin.publicKey,
        config: configPda,
        player: playerPda(user.publicKey),
        userToken: userTokens[index],
        vault: vaultPda,
        mint,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([user])
      .rpc();
  }

  async function createRound(opts: { kind?: "scheduled" | "duel"; fee?: number; maxPlayers?: number; lockIn?: number; deadlineIn?: number; signer?: Keypair } = {}) {
    const id = nextRoundId++;
    const signer = opts.signer ?? oracle;
    await program.methods
      .createRound(
        new BN(id),
        opts.kind === "duel" ? { duel: {} } : { scheduled: {} },
        1,
        new BN(opts.fee ?? 2 * USDC),
        opts.maxPlayers ?? 0,
        new BN(now() + (opts.lockIn ?? 30)),
        new BN(now() + (opts.deadlineIn ?? 60)),
        Array.from(Buffer.alloc(32, 7)),
      )
      .accountsPartial({ oracle: signer.publicKey, config: configPda, round: roundPda(id), systemProgram: SystemProgram.programId })
      .signers([signer])
      .rpc();
    return { id, round: roundPda(id) };
  }

  function enter(round: PublicKey, user: Keypair) {
    return program.methods
      .enterRound()
      .accountsPartial({
        user: user.publicKey,
        payer: admin.publicKey,
        config: configPda,
        round,
        player: playerPda(user.publicKey),
        entry: entryPda(round, user.publicKey),
        systemProgram: SystemProgram.programId,
      })
      .signers([user])
      .rpc();
  }

  function settle(round: PublicKey, winners: Keypair[], shares: number[], finalize = true, signer: Keypair = oracle) {
    return program.methods
      .settleRound(Array.from(Buffer.alloc(32, 1)), Array.from(Buffer.alloc(32, 2)), shares.map((s) => new BN(s)), finalize)
      .accountsPartial({
        oracle: signer.publicKey,
        config: configPda,
        round,
        vault: vaultPda,
        treasury,
        fees: feesPda,
        creatorPlayer: playerPda(creator.publicKey),
        mint,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts(
        winners.flatMap((w) => [
          { pubkey: entryPda(round, w.publicKey), isWritable: true, isSigner: false },
          { pubkey: playerPda(w.publicKey), isWritable: true, isSigner: false },
        ]),
      )
      .signers([signer])
      .rpc();
  }

  function refund(round: PublicKey, user: PublicKey) {
    return program.methods
      .refund()
      .accountsPartial({ caller: admin.publicKey, round, entry: entryPda(round, user), player: playerPda(user) })
      .rpc();
  }

  before(async () => {
    await Promise.all([oracle, ...users].map((k) => airdrop(k.publicKey)));
    mint = await createMint(conn, admin, admin.publicKey, null, 6);
    configPda = PublicKey.findProgramAddressSync([Buffer.from("config"), mint.toBuffer()], program.programId)[0];
    vaultPda = PublicKey.findProgramAddressSync([Buffer.from("vault"), mint.toBuffer()], program.programId)[0];
    feesPda = PublicKey.findProgramAddressSync([Buffer.from("fees"), mint.toBuffer()], program.programId)[0];
    treasury = await createAssociatedTokenAccount(conn, admin, mint, admin.publicKey);
    for (const user of users) {
      const ata = await createAssociatedTokenAccount(conn, admin, mint, user.publicKey);
      await mintTo(conn, admin, mint, ata, admin, 100 * USDC);
      userTokens.push(ata);
    }
    await program.methods
      .initConfig(oracle.publicKey, RAKE_BPS, 0, new BN(0))
      .accountsPartial({
        admin: admin.publicKey,
        config: configPda,
        mint,
        treasury,
        vault: vaultPda,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    await program.methods
      .initFees(CREATOR_BPS, creator.publicKey)
      .accountsPartial({ admin: admin.publicKey, config: configPda, fees: feesPda, systemProgram: SystemProgram.programId })
      .rpc();
  });

  it("deposits into an in-program balance", async () => {
    for (let i = 0; i < users.length; i += 1) await deposit(users[i], i, 20 * USDC);
    expect(await balanceOf(users[0].publicKey)).to.equal(20 * USDC);
    expect(Number((await getAccount(conn, vaultPda)).amount)).to.equal(60 * USDC);
  });

  it("rejects withdrawing more than the balance, allows a partial withdraw", async () => {
    const withdraw = (amount: number) =>
      program.methods
        .withdraw(new BN(amount))
        .accountsPartial({
          user: users[0].publicKey,
          config: configPda,
          player: playerPda(users[0].publicKey),
          vault: vaultPda,
          destination: userTokens[0],
          mint,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([users[0]])
        .rpc();
    await expectError(withdraw(21 * USDC), "InsufficientBalance");
    await withdraw(5 * USDC);
    expect(await balanceOf(users[0].publicKey)).to.equal(15 * USDC);
    await deposit(users[0], 0, 5 * USDC);
  });

  it("only the oracle can create rounds", async () => {
    await expectError(createRound({ signer: users[0] }), "ConstraintHasOne");
  });

  it("settles a scheduled round: one entry each, rake to treasury, exact payout", async () => {
    const { round } = await createRound({ lockIn: 4, deadlineIn: 40 });
    await enter(round, users[0]);
    await enter(round, users[1]);
    await expectError(enter(round, users[0]), "already in use");

    const pot = 2 * 2 * USDC;
    const distributable = distributableOf(pot);

    await expectError(settle(round, [users[0]], [distributable]), "RoundNotLocked");
    await sleep(5_000);
    await expectError(enter(round, users[2]), "RoundLocked");
    await expectError(settle(round, [users[0]], [distributable], true, users[1]), "ConstraintHasOne");
    await expectError(settle(round, [users[0]], [distributable - 1]), "PayoutIncomplete");

    const before = await Promise.all(users.map((u) => balanceOf(u.publicKey)));
    const half = distributable / 2;
    await settle(round, [users[0], users[1]], [half, half]);
    const after = await Promise.all(users.map((u) => balanceOf(u.publicKey)));
    expect(after[0] - before[0]).to.equal(half);
    expect(after[1] - before[1]).to.equal(half);
    expect(after[2]).to.equal(before[2]);
    expect(Number((await getAccount(conn, treasury)).amount)).to.equal(Math.floor((pot * RAKE_BPS) / 10_000));
    expect(await balanceOf(creator.publicKey)).to.equal(Math.floor((pot * CREATOR_BPS) / 10_000));

    const state = await program.account.round.fetch(round);
    expect(state.status).to.have.property("settled");
    await expectError(settle(round, [users[2]], [0]), "RoundClosed");
  });

  it("rejects paying someone who did not enter", async () => {
    const { round } = await createRound({ kind: "duel", maxPlayers: 2 });
    await enter(round, users[0]);
    await enter(round, users[1]);
    // users[2] has a Player account but no Entry for this round.
    await expectError(settle(round, [users[2]], [1]), "AccountNotInitialized");
  });

  it("duels: rejects a third player, settles as soon as the lobby is full", async () => {
    const { round } = await createRound({ kind: "duel", maxPlayers: 2 });
    await enter(round, users[0]);
    await enter(round, users[1]);
    await expectError(enter(round, users[2]), "RoundFull");
    const pot = 4 * USDC;
    await settle(round, [users[1]], [distributableOf(pot)]);
  });

  it("lock_round closes entries early and allows settling a table that isn't full", async () => {
    const { round } = await createRound({ maxPlayers: 6, lockIn: 60, deadlineIn: 120 });
    await enter(round, users[0]);
    await enter(round, users[1]);
    const pot = 4 * USDC;
    const distributable = distributableOf(pot);
    await expectError(settle(round, [users[0]], [distributable]), "RoundNotLocked");
    await program.methods
      .lockRound()
      .accountsPartial({ oracle: oracle.publicKey, config: configPda, round })
      .signers([oracle])
      .rpc();
    await expectError(enter(round, users[2]), "RoundLocked");
    await settle(round, [users[0]], [distributable]);
  });

  it("refunds everyone after a cancel, exactly once", async () => {
    const { round } = await createRound();
    await enter(round, users[2]);
    const before = await balanceOf(users[2].publicKey);
    await expectError(refund(round, users[2].publicKey), "RefundNotAllowed");
    await program.methods
      .cancelRound()
      .accountsPartial({ oracle: oracle.publicKey, config: configPda, round })
      .signers([oracle])
      .rpc();
    await refund(round, users[2].publicKey);
    expect(await balanceOf(users[2].publicKey)).to.equal(before + 2 * USDC);
    await expectError(refund(round, users[2].publicKey), "AlreadyPaid");
  });

  it("lets anyone refund once the settle deadline passes, and blocks a late settle", async () => {
    const { round } = await createRound({ lockIn: 2, deadlineIn: 4 });
    await enter(round, users[0]);
    const before = await balanceOf(users[0].publicKey);
    await sleep(5_500);
    await refund(round, users[0].publicKey);
    expect(await balanceOf(users[0].publicKey)).to.equal(before + 2 * USDC);
    await expectError(settle(round, [users[0]], [0]), "RoundClosed");
  });

  it("enforces the daily entry cap", async () => {
    await program.methods
      .updateConfig({ admin: null, oracle: null, treasury: null, rakeBps: null, maxEntriesPerDay: 1, maxPot: null, paused: null })
      .accountsPartial({ admin: admin.publicKey, config: configPda })
      .rpc();
    const a = await createRound();
    const b = await createRound();
    const fresh = Keypair.generate();
    await airdrop(fresh.publicKey);
    const ata = await createAssociatedTokenAccount(conn, admin, mint, fresh.publicKey);
    await mintTo(conn, admin, mint, ata, admin, 10 * USDC);
    userTokens.push(ata);
    await deposit(fresh, userTokens.length - 1, 10 * USDC);
    await enter(a.round, fresh);
    await expectError(enter(b.round, fresh), "DailyCapReached");
  });

  it("only the admin can change the creator fee, and the total stays under 20%", async () => {
    const update = (bps: number, signer?: Keypair) =>
      program.methods
        .updateFees(bps, creator.publicKey)
        .accountsPartial({ admin: (signer ?? admin).publicKey, config: configPda, fees: feesPda })
        .signers(signer ? [signer] : [])
        .rpc();
    await expectError(update(50, users[0]), "ConstraintHasOne");
    await expectError(update(1_300), "RakeTooHigh");
    await update(150);
    expect((await program.account.fees.fetch(feesPda)).creatorBps).to.equal(150);
    await update(CREATOR_BPS);
  });

  it("caps the house rake at 20%", async () => {
    await expectError(
      program.methods
        .updateConfig({ admin: null, oracle: null, treasury: null, rakeBps: 2_500, maxEntriesPerDay: null, maxPot: null, paused: null })
        .accountsPartial({ admin: admin.publicKey, config: configPda })
        .rpc(),
      "RakeTooHigh",
    );
  });

  it("fee tiers: bigger tables pay a bigger creator fee, with the house rake off", async () => {
    const setRake = (rakeBps: number) =>
      program.methods
        // The daily-cap test above leaves a cap of 1 entry; lift it (0 = no cap, as on devnet).
        .updateConfig({ admin: null, oracle: null, treasury: null, rakeBps, maxEntriesPerDay: 0, maxPot: null, paused: null })
        .accountsPartial({ admin: admin.publicKey, config: configPda })
        .rpc();
    const setTiers = (base: number, players: [number, number], bps: [number, number], signer?: Keypair) =>
      program.methods
        .setFeeTiers(base, players, bps)
        .accountsPartial({ admin: (signer ?? admin).publicKey, config: configPda, fees: feesPda, systemProgram: SystemProgram.programId })
        .signers(signer ? [signer] : [])
        .rpc();

    await expectError(setTiers(100, [3, 0], [500, 0], users[0]), "ConstraintHasOne");
    await expectError(setTiers(100, [5, 4], [200, 500]), "BadFeeTiers");
    await expectError(setTiers(100, [1, 0], [200, 0]), "BadFeeTiers");
    await expectError(setTiers(100, [3, 0], [2_500, 0]), "RakeTooHigh");

    await setRake(0);
    await setTiers(100, [3, 0], [500, 0]);
    const fees = await program.account.fees.fetch(feesPda);
    expect(fees.tierPlayers).to.deep.equal([3, 0]);
    expect(fees.tierBps).to.deep.equal([500, 0]);

    const treasuryBefore = Number((await getAccount(conn, treasury)).amount);
    const payOnce = async (players: Keypair[], bps: number) => {
      const { round } = await createRound({ maxPlayers: players.length });
      for (const u of players) await enter(round, u);
      const pot = 2 * USDC * players.length;
      const fee = Math.floor((pot * bps) / 10_000);
      const creatorBefore = await balanceOf(creator.publicKey);
      await expectError(settle(round, [players[0]], [pot - fee - 1]), "PayoutIncomplete");
      await settle(round, [players[0]], [pot - fee]);
      expect((await balanceOf(creator.publicKey)) - creatorBefore).to.equal(fee);
    };
    await payOnce([users[0], users[1]], 100); // below the tier: base 1%
    await payOnce([users[0], users[1], users[2]], 500); // 3+ players: 5%
    expect(Number((await getAccount(conn, treasury)).amount)).to.equal(treasuryBefore); // no house rake

    await setTiers(CREATOR_BPS, [0, 0], [0, 0]);
    await setRake(RAKE_BPS);
  });

  describe("native SOL pool (how the site runs on devnet)", () => {
    const LAMPORTS = 1_000_000_000;
    const NATIVE = new PublicKey("So11111111111111111111111111111111111111112");
    const cfg = PublicKey.findProgramAddressSync([Buffer.from("config"), NATIVE.toBuffer()], program.programId)[0];
    const vlt = PublicKey.findProgramAddressSync([Buffer.from("vault"), NATIVE.toBuffer()], program.programId)[0];
    const fee = PublicKey.findProgramAddressSync([Buffer.from("fees"), NATIVE.toBuffer()], program.programId)[0];
    const solPlayer = (u: PublicKey) =>
      PublicKey.findProgramAddressSync([Buffer.from("player"), NATIVE.toBuffer(), u.toBuffer()], program.programId)[0];
    const unwrap = (u: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("unwrap"), u.toBuffer()], program.programId)[0];
    const solBalance = async (u: PublicKey) => Number((await program.account.player.fetch(solPlayer(u))).balance);
    const alice = Keypair.generate();
    const bob = Keypair.generate();
    const solCreator = Keypair.generate();

    const depositIx = (u: Keypair, lamports: number) =>
      program.methods
        .depositNative(new BN(lamports))
        .accountsPartial({ user: u.publicKey, payer: u.publicKey, config: cfg, player: solPlayer(u.publicKey), vault: vlt, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId })
        .instruction();
    const enterIx = (round: PublicKey, u: Keypair) =>
      program.methods
        .enterRound()
        .accountsPartial({ user: u.publicKey, payer: u.publicKey, config: cfg, round, player: solPlayer(u.publicKey), entry: entryPda(round, u.publicKey), systemProgram: SystemProgram.programId })
        .instruction();

    before(async () => {
      await Promise.all([alice, bob].map((k) => airdrop(k.publicKey)));
      const treasuryWsol = await createAssociatedTokenAccount(conn, admin, NATIVE, admin.publicKey);
      await program.methods
        .initConfig(oracle.publicKey, RAKE_BPS, 0, new BN(0))
        .accountsPartial({ admin: admin.publicKey, config: cfg, mint: NATIVE, treasury: treasuryWsol, vault: vlt, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId })
        .rpc();
      await program.methods
        .initFees(CREATOR_BPS, solCreator.publicKey)
        .accountsPartial({ admin: admin.publicKey, config: cfg, fees: fee, systemProgram: SystemProgram.programId })
        .rpc();
    });

    it("deposit_native moves plain SOL from the wallet into the vault", async () => {
      const before = await conn.getBalance(alice.publicKey);
      const tx = new anchor.web3.Transaction().add(await depositIx(alice, 0.1 * LAMPORTS));
      await anchor.web3.sendAndConfirmTransaction(conn, tx, [alice]);
      expect(await solBalance(alice.publicKey)).to.equal(0.1 * LAMPORTS);
      expect(before - (await conn.getBalance(alice.publicKey))).to.be.greaterThan(0.1 * LAMPORTS); // + fee + player rent
      expect(Number((await getAccount(conn, vlt)).amount)).to.be.greaterThanOrEqual(0.1 * LAMPORTS);
    });

    it("join = deposit + enter in one tx, signed only by the player (the site's external-wallet flow)", async () => {
      const id = nextRoundId++;
      const round = roundPda(id);
      await program.methods
        .createRound(new BN(id), { scheduled: {} }, 0, new BN(0.02 * LAMPORTS), 6, new BN(now() + 60), new BN(now() + 120), Array.from(Buffer.alloc(32)))
        .accountsPartial({ oracle: oracle.publicKey, config: cfg, round, systemProgram: SystemProgram.programId })
        .signers([oracle])
        .rpc();
      for (const u of [alice, bob]) {
        const tx = new anchor.web3.Transaction().add(await depositIx(u, 0.02 * LAMPORTS), await enterIx(round, u));
        tx.feePayer = u.publicKey;
        await anchor.web3.sendAndConfirmTransaction(conn, tx, [u]);
      }
      expect(Number((await program.account.round.fetch(round)).pot)).to.equal(0.04 * LAMPORTS);

      await program.methods.lockRound().accountsPartial({ oracle: oracle.publicKey, config: cfg, round }).signers([oracle]).rpc();
      const pot = 0.04 * LAMPORTS;
      const share = distributableOf(pot);
      await program.methods
        .settleRound(Array.from(Buffer.alloc(32, 1)), Array.from(Buffer.alloc(32, 2)), [new BN(share)], true)
        .accountsPartial({
          oracle: oracle.publicKey,
          config: cfg,
          round,
          vault: vlt,
          treasury: (await program.account.config.fetch(cfg)).treasury,
          fees: fee,
          creatorPlayer: solPlayer(solCreator.publicKey),
          mint: NATIVE,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts([
          { pubkey: entryPda(round, bob.publicKey), isWritable: true, isSigner: false },
          { pubkey: solPlayer(bob.publicKey), isWritable: true, isSigner: false },
        ])
        .signers([oracle])
        .rpc();
      expect(await solBalance(bob.publicKey)).to.equal(share);
      expect(await solBalance(solCreator.publicKey)).to.equal(Math.floor((pot * CREATOR_BPS) / 10_000));
    });

    it("leave_round refunds a lone player and frees the seat, but not once an opponent joined", async () => {
      const id = nextRoundId++;
      const round = roundPda(id);
      await program.methods
        .createRound(new BN(id), { scheduled: {} }, 0, new BN(0.02 * LAMPORTS), 6, new BN(now() + 60), new BN(now() + 120), Array.from(Buffer.alloc(32)))
        .accountsPartial({ oracle: oracle.publicKey, config: cfg, round, systemProgram: SystemProgram.programId })
        .signers([oracle])
        .rpc();
      const join = async (u: Keypair) => {
        const tx = new anchor.web3.Transaction().add(await depositIx(u, 0.02 * LAMPORTS), await enterIx(round, u));
        tx.feePayer = u.publicKey;
        await anchor.web3.sendAndConfirmTransaction(conn, tx, [u]);
      };
      const leave = (u: Keypair) =>
        program.methods
          .leaveRound()
          .accountsPartial({ oracle: oracle.publicKey, config: cfg, round, entry: entryPda(round, u.publicKey), player: solPlayer(u.publicKey) })
          .signers([oracle])
          .rpc();

      const before = await solBalance(alice.publicKey);
      await join(alice);
      expect(await solBalance(alice.publicKey)).to.equal(before);
      await leave(alice);
      expect(await solBalance(alice.publicKey)).to.equal(before + 0.02 * LAMPORTS);
      const r = await program.account.round.fetch(round);
      expect(r.players).to.equal(0);
      expect(Number(r.pot)).to.equal(0);
      expect(await conn.getAccountInfo(entryPda(round, alice.publicKey))).to.equal(null);

      await join(alice); // seat freed: can rejoin
      await join(bob);
      await expectError(leave(alice), "OpponentJoined");
    });

    it("withdraw_native sends plain SOL back to the wallet and leaves no temp account", async () => {
      const amount = await solBalance(bob.publicKey);
      const before = await conn.getBalance(bob.publicKey);
      await program.methods
        .withdrawNative(new BN(amount))
        .accountsPartial({ user: bob.publicKey, payer: bob.publicKey, config: cfg, player: solPlayer(bob.publicKey), vault: vlt, unwrap: unwrap(bob.publicKey), mint: NATIVE, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId })
        .signers([bob])
        .rpc();
      expect(await solBalance(bob.publicKey)).to.equal(0);
      const gained = (await conn.getBalance(bob.publicKey)) - before;
      expect(gained).to.be.greaterThan(amount - 10_000); // amount back, minus the tx fee
      expect(await conn.getAccountInfo(unwrap(bob.publicKey))).to.equal(null);
      await expectError(
        program.methods
          .withdrawNative(new BN(1))
          .accountsPartial({ user: bob.publicKey, payer: bob.publicKey, config: cfg, player: solPlayer(bob.publicKey), vault: vlt, unwrap: unwrap(bob.publicKey), mint: NATIVE, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId })
          .signers([bob])
          .rpc(),
        "InsufficientBalance",
      );
    });
  });
});
