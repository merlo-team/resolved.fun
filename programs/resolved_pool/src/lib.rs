//! resolved.fun prize pools.
//!
//! One pool per token mint (wrapped SOL today, USDC later): config, vault and player balances are
//! all seeded by the mint. Players keep a balance inside the program (deposit once, enter many games, withdraw any
//! time). Entering a Round or Duel moves the entry fee from that balance into the round's pot.
//! The game server is the oracle: it creates rounds (with a commitment to the question set) and
//! settles them by crediting winners. The program enforces the money rules the server cannot
//! bend: one entry per player per round, payouts only to that round's entrants, payouts that sum
//! exactly to pot minus the configured rake (or, when nobody survives, the whole pot to the house
//! and creator), and refunds anyone can trigger once a round is
//! cancelled or its settle deadline passes unsettled.

use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::token::spl_token::native_mint;
use anchor_spl::token_interface::{
    close_account, sync_native, transfer_checked, CloseAccount, Mint, SyncNative, TokenAccount, TokenInterface, TransferChecked,
};

declare_id!("BJoVhD81MFEWzpbXKhuvZmh8HiA5bU3RJ9eirTbuSpNy");

/// Shown on Solscan / Explorer under Security. Survives only after the next program upgrade.
#[cfg(not(feature = "no-entrypoint"))]
use solana_security_txt::security_txt;

#[cfg(not(feature = "no-entrypoint"))]
security_txt! {
    name: "Resolved.fun",
    project_url: "https://resolved.fun",
    contacts: "link:https://github.com/merlo-team/resolved.fun/security/advisories/new,twitter:resolvedfun",
    policy: "https://github.com/merlo-team/resolved.fun/blob/main/SECURITY.md",
    preferred_languages: "en",
    source_code: "https://github.com/merlo-team/resolved.fun",
    auditors: "None"
}

const DAY: i64 = 86_400;
/// Hard ceiling on the house cut, whatever the admin configures.
const MAX_RAKE_BPS: u16 = 2_000;
const BPS: u128 = 10_000;

#[program]
pub mod resolved_pool {
    use super::*;

    pub fn init_config(
        ctx: Context<InitConfig>,
        oracle: Pubkey,
        rake_bps: u16,
        max_entries_per_day: u16,
        max_pot: u64,
    ) -> Result<()> {
        require!(rake_bps <= MAX_RAKE_BPS, PoolError::RakeTooHigh);
        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.admin.key();
        config.oracle = oracle;
        config.mint = ctx.accounts.mint.key();
        config.treasury = ctx.accounts.treasury.key();
        config.rake_bps = rake_bps;
        config.max_entries_per_day = max_entries_per_day;
        config.max_pot = max_pot;
        config.paused = false;
        config.bump = ctx.bumps.config;
        config.vault_bump = ctx.bumps.vault;
        Ok(())
    }

    pub fn update_config(ctx: Context<UpdateConfig>, update: ConfigUpdate) -> Result<()> {
        let config = &mut ctx.accounts.config;
        if let Some(admin) = update.admin {
            config.admin = admin;
        }
        if let Some(oracle) = update.oracle {
            config.oracle = oracle;
        }
        if let Some(treasury) = update.treasury {
            config.treasury = treasury;
        }
        if let Some(rake_bps) = update.rake_bps {
            require!(rake_bps <= MAX_RAKE_BPS, PoolError::RakeTooHigh);
            config.rake_bps = rake_bps;
        }
        if let Some(cap) = update.max_entries_per_day {
            config.max_entries_per_day = cap;
        }
        if let Some(max_pot) = update.max_pot {
            config.max_pot = max_pot;
        }
        if let Some(paused) = update.paused {
            config.paused = paused;
        }
        Ok(())
    }

    /// Sets up the creator fee for this pool (admin only). House rake + creator fee ≤ 20%.
    pub fn init_fees(ctx: Context<InitFees>, creator_bps: u16, creator: Pubkey) -> Result<()> {
        require!(ctx.accounts.config.rake_bps + creator_bps <= MAX_RAKE_BPS, PoolError::RakeTooHigh);
        let fees = &mut ctx.accounts.fees;
        fees.creator = creator;
        fees.creator_bps = creator_bps;
        fees.bump = ctx.bumps.fees;
        Ok(())
    }

    /// Changes the creator fee and/or where it's paid (admin only).
    pub fn update_fees(ctx: Context<UpdateFees>, creator_bps: u16, creator: Pubkey) -> Result<()> {
        let top = creator_bps.max(ctx.accounts.fees.tier_bps[0]).max(ctx.accounts.fees.tier_bps[1]);
        require!(ctx.accounts.config.rake_bps + top <= MAX_RAKE_BPS, PoolError::RakeTooHigh);
        let fees = &mut ctx.accounts.fees;
        fees.creator = creator;
        fees.creator_bps = creator_bps;
        Ok(())
    }

    /// Admin-only: credit an in-program balance (vault already holds the tokens). Used to repair
    /// payouts that were wiped when the house wallet also won a round.
    pub fn credit_balance(ctx: Context<CreditBalance>, amount: u64) -> Result<()> {
        require!(amount > 0, PoolError::ZeroAmount);
        require_keys_eq!(ctx.accounts.player.mint, ctx.accounts.config.mint, PoolError::WrongMint);
        let player = &mut ctx.accounts.player;
        player.balance = player.balance.checked_add(amount).ok_or(PoolError::Overflow)?;
        emit!(BalanceChanged { user: player.user, balance: player.balance });
        Ok(())
    }

    /// Fee by table size (admin only): `creator_bps` for small tables, `tier_bps[i]` once a round has
    /// at least `tier_players[i]` players (0 = tier off). House rake + any tier ≤ 20%. Also upgrades a
    /// Fees account created before tiers existed (grows it in place, admin pays the extra rent).
    pub fn set_fee_tiers(ctx: Context<SetFeeTiers>, creator_bps: u16, tier_players: [u16; 2], tier_bps: [u16; 2]) -> Result<()> {
        let rake = ctx.accounts.config.rake_bps;
        for bps in [creator_bps, tier_bps[0], tier_bps[1]] {
            require!(rake + bps <= MAX_RAKE_BPS, PoolError::RakeTooHigh);
        }
        let (first, second) = (tier_players[0], tier_players[1]);
        require!(first == 0 || first >= 2, PoolError::BadFeeTiers);
        require!(second == 0 || (second >= 2 && (first == 0 || second > first)), PoolError::BadFeeTiers);

        let info = ctx.accounts.fees.to_account_info();
        let need = 8 + Fees::INIT_SPACE;
        if info.data_len() < need {
            let lack = Rent::get()?.minimum_balance(need).saturating_sub(info.lamports());
            if lack > 0 {
                system_program::transfer(
                    CpiContext::new(
                        ctx.accounts.system_program.to_account_info(),
                        system_program::Transfer { from: ctx.accounts.admin.to_account_info(), to: info.clone() },
                    ),
                    lack,
                )?;
            }
            info.realloc(need, true)?;
        }
        let mut fees = Fees::try_deserialize(&mut &info.try_borrow_data()?[..])?;
        fees.creator_bps = creator_bps;
        fees.tier_players = tier_players;
        fees.tier_bps = tier_bps;
        fees.try_serialize(&mut &mut info.try_borrow_mut_data()?[..])?;
        Ok(())
    }

    /// SOL pool only: plain SOL from the wallet straight into the vault (no wSOL account in the
    /// user's wallet), then synced so the vault's token balance matches. One simple transfer for wallets.
    pub fn deposit_native(ctx: Context<DepositNative>, amount: u64) -> Result<()> {
        require!(amount > 0, PoolError::ZeroAmount);
        require!(!ctx.accounts.config.paused, PoolError::Paused);
        require_keys_eq!(ctx.accounts.config.mint, native_mint::ID, PoolError::WrongMint);

        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer { from: ctx.accounts.user.to_account_info(), to: ctx.accounts.vault.to_account_info() },
            ),
            amount,
        )?;
        sync_native(CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            SyncNative { account: ctx.accounts.vault.to_account_info() },
        ))?;

        let player = &mut ctx.accounts.player;
        if player.user == Pubkey::default() {
            player.user = ctx.accounts.user.key();
            player.mint = ctx.accounts.config.mint;
            player.bump = ctx.bumps.player;
        }
        player.balance = player.balance.checked_add(amount).ok_or(PoolError::Overflow)?;
        emit!(BalanceChanged { user: player.user, balance: player.balance });
        Ok(())
    }

    /// SOL pool only: unwraps inside a temporary program-owned account and sends plain SOL to the
    /// user's wallet (the temp account's rent comes back to the user too). Allowed while paused.
    pub fn withdraw_native(ctx: Context<WithdrawNative>, amount: u64) -> Result<()> {
        require!(amount > 0, PoolError::ZeroAmount);
        require_keys_eq!(ctx.accounts.config.mint, native_mint::ID, PoolError::WrongMint);
        let player = &mut ctx.accounts.player;
        require!(player.balance >= amount, PoolError::InsufficientBalance);
        player.balance -= amount;

        let seeds: &[&[u8]] = &[b"config", ctx.accounts.config.mint.as_ref(), &[ctx.accounts.config.bump]];
        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.vault.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.unwrap.to_account_info(),
                    authority: ctx.accounts.config.to_account_info(),
                },
                &[seeds],
            ),
            amount,
            ctx.accounts.mint.decimals,
        )?;
        close_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            CloseAccount {
                account: ctx.accounts.unwrap.to_account_info(),
                destination: ctx.accounts.user.to_account_info(),
                authority: ctx.accounts.config.to_account_info(),
            },
            &[seeds],
        ))?;
        emit!(BalanceChanged { user: player.user, balance: player.balance });
        Ok(())
    }

    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        require!(amount > 0, PoolError::ZeroAmount);
        require!(!ctx.accounts.config.paused, PoolError::Paused);

        transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.user_token.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            amount,
            ctx.accounts.mint.decimals,
        )?;

        let player = &mut ctx.accounts.player;
        if player.user == Pubkey::default() {
            player.user = ctx.accounts.user.key();
            player.mint = ctx.accounts.mint.key();
            player.bump = ctx.bumps.player;
        }
        player.balance = player.balance.checked_add(amount).ok_or(PoolError::Overflow)?;
        emit!(BalanceChanged { user: player.user, balance: player.balance });
        Ok(())
    }

    /// Always allowed, even while paused: players can never be locked out of their balance.
    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        require!(amount > 0, PoolError::ZeroAmount);
        let player = &mut ctx.accounts.player;
        require!(player.balance >= amount, PoolError::InsufficientBalance);
        player.balance -= amount;

        let seeds: &[&[u8]] = &[b"config", ctx.accounts.config.mint.as_ref(), &[ctx.accounts.config.bump]];
        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.vault.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.destination.to_account_info(),
                    authority: ctx.accounts.config.to_account_info(),
                },
                &[seeds],
            ),
            amount,
            ctx.accounts.mint.decimals,
        )?;
        emit!(BalanceChanged { user: player.user, balance: player.balance });
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn create_round(
        ctx: Context<CreateRound>,
        round_id: u64,
        kind: RoundKind,
        level: u8,
        entry_fee: u64,
        max_players: u16,
        locks_at: i64,
        settle_deadline: i64,
        question_commit: [u8; 32],
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(entry_fee > 0, PoolError::ZeroAmount);
        require!(now < locks_at && locks_at < settle_deadline, PoolError::BadSchedule);
        require!(max_players == 0 || max_players >= 2, PoolError::BadSchedule);

        let round = &mut ctx.accounts.round;
        round.round_id = round_id;
        round.mint = ctx.accounts.config.mint;
        round.kind = kind;
        round.level = level;
        round.entry_fee = entry_fee;
        round.max_players = max_players;
        round.locks_at = locks_at;
        round.settle_deadline = settle_deadline;
        round.question_commit = question_commit;
        round.status = RoundStatus::Open;
        round.bump = ctx.bumps.round;
        Ok(())
    }

    pub fn enter_round(ctx: Context<EnterRound>) -> Result<()> {
        let config = &ctx.accounts.config;
        let round = &mut ctx.accounts.round;
        let player = &mut ctx.accounts.player;
        let now = Clock::get()?.unix_timestamp;

        require!(!config.paused, PoolError::Paused);
        require_keys_eq!(round.mint, config.mint, PoolError::WrongMint);
        require!(round.status == RoundStatus::Open, PoolError::RoundClosed);
        require!(now < round.locks_at, PoolError::RoundLocked);
        require!(round.max_players == 0 || round.players < round.max_players, PoolError::RoundFull);
        require!(player.balance >= round.entry_fee, PoolError::InsufficientBalance);

        let pot = round.pot.checked_add(round.entry_fee).ok_or(PoolError::Overflow)?;
        require!(config.max_pot == 0 || pot <= config.max_pot, PoolError::PotCapReached);

        let day = now.div_euclid(DAY);
        if player.day != day {
            player.day = day;
            player.entries_today = 0;
        }
        require!(
            config.max_entries_per_day == 0 || player.entries_today < config.max_entries_per_day,
            PoolError::DailyCapReached
        );

        player.balance -= round.entry_fee;
        player.entries_today += 1;
        round.pot = pot;
        round.players += 1;

        let entry = &mut ctx.accounts.entry;
        entry.round = round.key();
        entry.user = player.user;
        entry.bump = ctx.bumps.entry;

        emit!(RoundEntered { round: round.key(), user: player.user, players: round.players, pot: round.pot });
        Ok(())
    }

    /// Credits winners. The first call takes the rake and records the results root + reveal salt;
    /// large rounds pass winners in batches and set `finalize` on the last one, which requires the
    /// whole distributable pot to have been paid out. `remaining_accounts` = [entry, player] pairs.
    pub fn settle_round<'info>(
        ctx: Context<'_, '_, 'info, 'info, SettleRound<'info>>,
        results_root: [u8; 32],
        reveal_salt: [u8; 32],
        shares: Vec<u64>,
        finalize: bool,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let round_key = ctx.accounts.round.key();
        require_keys_eq!(ctx.accounts.round.mint, ctx.accounts.config.mint, PoolError::WrongMint);

        match ctx.accounts.round.status {
            RoundStatus::Open => {
                require_settleable(&ctx.accounts.round, now)?;
                let pot = ctx.accounts.round.pot;
                let deducted = take_fees(ctx.accounts, ctx.bumps.creator_player, pot)?;
                let round = &mut ctx.accounts.round;
                // `rake` holds every deduction (house + creator), so distributable = pot − rake.
                round.rake = deducted;
                round.results_root = results_root;
                round.reveal_salt = reveal_salt;
                round.status = RoundStatus::Settling;
            }
            RoundStatus::Settling => {
                require!(ctx.accounts.round.results_root == results_root, PoolError::ResultsMismatch);
            }
            _ => return err!(PoolError::RoundClosed),
        }
        let round = &mut ctx.accounts.round;

        let pairs = ctx.remaining_accounts;
        require!(pairs.len() == shares.len() * 2, PoolError::WinnerAccountsMismatch);
        let distributable = round.pot - round.rake;
        // If the house wallet won, never wrap its Player PDA twice: the typed `creator_player`
        // account would serialize after the remaining-accounts wrapper and wipe the payout.
        let creator_key = ctx.accounts.creator_player.key();
        let mut creator_winnings: u64 = 0;

        for (i, share) in shares.iter().enumerate() {
            let mut entry: Account<'info, Entry> = Account::try_from(&pairs[i * 2])?;
            require_keys_eq!(entry.round, round_key, PoolError::NotAnEntrant);
            require!(!entry.paid && !entry.refunded, PoolError::AlreadyPaid);

            if pairs[i * 2 + 1].key() == creator_key {
                require_keys_eq!(ctx.accounts.creator_player.user, entry.user, PoolError::NotAnEntrant);
                require_keys_eq!(ctx.accounts.creator_player.mint, round.mint, PoolError::WrongMint);
                entry.paid = true;
                creator_winnings = creator_winnings.checked_add(*share).ok_or(PoolError::Overflow)?;
            } else {
                let mut player: Account<'info, Player> = Account::try_from(&pairs[i * 2 + 1])?;
                require_keys_eq!(player.user, entry.user, PoolError::NotAnEntrant);
                require_keys_eq!(player.mint, round.mint, PoolError::WrongMint);
                entry.paid = true;
                player.balance = player.balance.checked_add(*share).ok_or(PoolError::Overflow)?;
                player.exit(&crate::ID)?;
            }
            round.paid_out = round.paid_out.checked_add(*share).ok_or(PoolError::Overflow)?;
            require!(round.paid_out <= distributable, PoolError::PayoutExceedsPot);
            entry.exit(&crate::ID)?;
        }
        if creator_winnings > 0 {
            let creator = &mut ctx.accounts.creator_player;
            creator.balance = creator.balance.checked_add(creator_winnings).ok_or(PoolError::Overflow)?;
        }

        if finalize {
            require!(round.paid_out == distributable, PoolError::PayoutIncomplete);
            round.status = RoundStatus::Settled;
            emit!(RoundSettled { round: round_key, rake: round.rake, paid_out: round.paid_out });
        }
        Ok(())
    }

    /// Nobody survived: after the usual fees, the rest of the pot is credited to the creator's
    /// in-program balance (withdrawable like any winnings). Same checks as a first settle.
    pub fn settle_to_house(ctx: Context<SettleRound>, results_root: [u8; 32], reveal_salt: [u8; 32]) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let round_key = ctx.accounts.round.key();
        require_keys_eq!(ctx.accounts.round.mint, ctx.accounts.config.mint, PoolError::WrongMint);
        require!(ctx.accounts.round.status == RoundStatus::Open, PoolError::RoundClosed);
        require_settleable(&ctx.accounts.round, now)?;

        let pot = ctx.accounts.round.pot;
        let deducted = take_fees(ctx.accounts, ctx.bumps.creator_player, pot)?;
        let leftover = pot - deducted;
        let creator = &mut ctx.accounts.creator_player;
        creator.balance = creator.balance.checked_add(leftover).ok_or(PoolError::Overflow)?;

        let round = &mut ctx.accounts.round;
        round.rake = pot;
        round.results_root = results_root;
        round.reveal_salt = reveal_salt;
        round.status = RoundStatus::Settled;
        emit!(RoundSettled { round: round_key, rake: pot, paid_out: 0 });
        Ok(())
    }

    /// Closes entries now (tables start when their countdown ends, not at a fixed time). Settling
    /// is only allowed once a round is locked or full.
    pub fn lock_round(ctx: Context<CancelRound>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let round = &mut ctx.accounts.round;
        require_keys_eq!(round.mint, ctx.accounts.config.mint, PoolError::WrongMint);
        require!(round.status == RoundStatus::Open, PoolError::RoundClosed);
        if now < round.locks_at {
            round.locks_at = now;
        }
        Ok(())
    }

    /// Oracle-only: a player leaves a lobby before any opponent has joined (they're the only
    /// entrant). Their entry goes back to their balance and the Entry account is closed, so the
    /// seat is free and they can come back later.
    pub fn leave_round(ctx: Context<LeaveRound>) -> Result<()> {
        let round = &mut ctx.accounts.round;
        let entry = &ctx.accounts.entry;
        let player = &mut ctx.accounts.player;
        require_keys_eq!(round.mint, ctx.accounts.config.mint, PoolError::WrongMint);
        require!(round.status == RoundStatus::Open, PoolError::RoundClosed);
        require!(round.players == 1, PoolError::OpponentJoined);
        require!(!entry.paid && !entry.refunded, PoolError::AlreadyPaid);

        round.players -= 1;
        round.pot -= round.entry_fee;
        player.balance = player.balance.checked_add(round.entry_fee).ok_or(PoolError::Overflow)?;
        emit!(BalanceChanged { user: player.user, balance: player.balance });
        Ok(())
    }

    pub fn cancel_round(ctx: Context<CancelRound>) -> Result<()> {
        let round = &mut ctx.accounts.round;
        require_keys_eq!(round.mint, ctx.accounts.config.mint, PoolError::WrongMint);
        require!(round.status == RoundStatus::Open, PoolError::RoundClosed);
        round.status = RoundStatus::Cancelled;
        Ok(())
    }

    /// Anyone may call this for any entry once the round is cancelled, or once its settle deadline
    /// has passed without a settlement (which also cancels the round, blocking a late settle).
    pub fn refund(ctx: Context<Refund>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let round = &mut ctx.accounts.round;
        let entry = &mut ctx.accounts.entry;
        let player = &mut ctx.accounts.player;

        match round.status {
            RoundStatus::Cancelled => {}
            RoundStatus::Open if now > round.settle_deadline => round.status = RoundStatus::Cancelled,
            _ => return err!(PoolError::RefundNotAllowed),
        }
        require!(!entry.refunded && !entry.paid, PoolError::AlreadyPaid);

        entry.refunded = true;
        round.pot -= round.entry_fee;
        player.balance = player.balance.checked_add(round.entry_fee).ok_or(PoolError::Overflow)?;
        emit!(BalanceChanged { user: player.user, balance: player.balance });
        Ok(())
    }
}

fn require_settleable(round: &Round, now: i64) -> Result<()> {
    require!(now <= round.settle_deadline, PoolError::SettleDeadlinePassed);
    let full = round.max_players > 0 && round.players == round.max_players;
    require!(now >= round.locks_at || full, PoolError::RoundNotLocked);
    require!(round.players > 0, PoolError::NoPlayers);
    Ok(())
}

/// Moves the house rake to the treasury and credits the creator fee to the creator's in-program
/// balance (it stays in the vault, so no external token account can break payouts). Returns the
/// total deducted from the pot.
fn take_fees(a: &mut SettleRound, creator_bump: u8, pot: u64) -> Result<u64> {
    let rake = ((pot as u128) * (a.config.rake_bps as u128) / BPS) as u64;
    if rake > 0 {
        let seeds: &[&[u8]] = &[b"config", a.config.mint.as_ref(), &[a.config.bump]];
        transfer_checked(
            CpiContext::new_with_signer(
                a.token_program.to_account_info(),
                TransferChecked {
                    from: a.vault.to_account_info(),
                    mint: a.mint.to_account_info(),
                    to: a.treasury.to_account_info(),
                    authority: a.config.to_account_info(),
                },
                &[seeds],
            ),
            rake,
            a.mint.decimals,
        )?;
    }
    let creator = &mut a.creator_player;
    if creator.user == Pubkey::default() {
        creator.user = a.fees.creator;
        creator.mint = a.config.mint;
        creator.bump = creator_bump;
    }
    let creator_fee = ((pot as u128) * (creator_bps_for(&a.fees, a.round.players) as u128) / BPS) as u64;
    creator.balance = creator.balance.checked_add(creator_fee).ok_or(PoolError::Overflow)?;
    Ok(rake + creator_fee)
}

/// The creator fee for a round of `players`: the highest tier it reaches, else the base fee.
fn creator_bps_for(fees: &Fees, players: u16) -> u16 {
    let mut bps = fees.creator_bps;
    for i in 0..2 {
        if fees.tier_players[i] > 0 && players >= fees.tier_players[i] {
            bps = fees.tier_bps[i];
        }
    }
    bps
}

// ---------------------------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------------------------

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    pub oracle: Pubkey,
    pub mint: Pubkey,
    pub treasury: Pubkey,
    pub rake_bps: u16,
    pub max_entries_per_day: u16,
    pub max_pot: u64,
    pub paused: bool,
    pub bump: u8,
    pub vault_bump: u8,
}

/// Creator fee for one currency pool, kept separate from Config so it can be added and tuned later.
#[account]
#[derive(InitSpace)]
pub struct Fees {
    /// Wallet credited with the creator fee (into its in-program balance, withdrawable as SOL).
    pub creator: Pubkey,
    /// Fee for tables below every tier (e.g. duels).
    pub creator_bps: u16,
    pub bump: u8,
    /// Bigger tables pay more: a round with at least `tier_players[i]` players pays `tier_bps[i]`
    /// (the highest tier reached wins; 0 players = tier off). Appended fields: older accounts are
    /// grown by `set_fee_tiers` and read as "no tiers" until then.
    pub tier_players: [u16; 2],
    pub tier_bps: [u16; 2],
}

#[account]
#[derive(InitSpace)]
pub struct Player {
    pub mint: Pubkey,
    pub user: Pubkey,
    pub balance: u64,
    pub entries_today: u16,
    pub day: i64,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace, Debug)]
pub enum RoundKind {
    Scheduled,
    Duel,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace, Debug)]
pub enum RoundStatus {
    Open,
    Settling,
    Settled,
    Cancelled,
}

#[account]
#[derive(InitSpace)]
pub struct Round {
    pub round_id: u64,
    /// Currency of this round's pot; must match the config it is entered / settled through.
    pub mint: Pubkey,
    pub kind: RoundKind,
    pub level: u8,
    pub entry_fee: u64,
    /// 0 = unlimited (Scheduled); 2–8 for Duels.
    pub max_players: u16,
    pub players: u16,
    pub pot: u64,
    pub rake: u64,
    pub paid_out: u64,
    pub locks_at: i64,
    pub settle_deadline: i64,
    /// sha256(round_id ‖ question ids ‖ salt), revealed via `reveal_salt` at settlement.
    pub question_commit: [u8; 32],
    /// Merkle root of every player's (answers, timings, score) for off-chain verification.
    pub results_root: [u8; 32],
    pub reveal_salt: [u8; 32],
    pub status: RoundStatus,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Entry {
    pub round: Pubkey,
    pub user: Pubkey,
    pub paid: bool,
    pub refunded: bool,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Default)]
pub struct ConfigUpdate {
    pub admin: Option<Pubkey>,
    pub oracle: Option<Pubkey>,
    pub treasury: Option<Pubkey>,
    pub rake_bps: Option<u16>,
    pub max_entries_per_day: Option<u16>,
    pub max_pot: Option<u64>,
    pub paused: Option<bool>,
}

// ---------------------------------------------------------------------------------------------
// Instruction contexts
// ---------------------------------------------------------------------------------------------

#[derive(Accounts)]
pub struct InitConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(init, payer = admin, space = 8 + Config::INIT_SPACE, seeds = [b"config", mint.key().as_ref()], bump)]
    pub config: Box<Account<'info, Config>>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(token::mint = mint, token::token_program = token_program)]
    pub treasury: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        init,
        payer = admin,
        seeds = [b"vault", mint.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = config,
        token::token_program = token_program,
    )]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CreditBalance<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [b"config", config.mint.as_ref()], bump = config.bump, has_one = admin)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [b"player", config.mint.as_ref(), player.user.as_ref()], bump = player.bump)]
    pub player: Account<'info, Player>,
}

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [b"config", config.mint.as_ref()], bump = config.bump, has_one = admin)]
    pub config: Box<Account<'info, Config>>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    pub user: Signer<'info>,
    /// Pays rent for a new Player account; the server can sponsor it so users only hold USDC.
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [b"config", config.mint.as_ref()], bump = config.bump, has_one = mint)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + Player::INIT_SPACE,
        seeds = [b"player", config.mint.as_ref(), user.key().as_ref()],
        bump,
    )]
    pub player: Account<'info, Player>,
    #[account(mut, token::mint = mint, token::authority = user, token::token_program = token_program)]
    pub user_token: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, seeds = [b"vault", config.mint.as_ref()], bump = config.vault_bump)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DepositNative<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    /// Pays rent for a new Player account (normally the user themselves).
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [b"config", config.mint.as_ref()], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + Player::INIT_SPACE,
        seeds = [b"player", config.mint.as_ref(), user.key().as_ref()],
        bump,
    )]
    pub player: Box<Account<'info, Player>>,
    #[account(mut, seeds = [b"vault", config.mint.as_ref()], bump = config.vault_bump)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct WithdrawNative<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    /// Pays the temp account's rent, which is returned to `user` when it's closed.
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [b"config", config.mint.as_ref()], bump = config.bump, has_one = mint)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [b"player", config.mint.as_ref(), user.key().as_ref()], bump = player.bump, has_one = user)]
    pub player: Box<Account<'info, Player>>,
    #[account(mut, seeds = [b"vault", config.mint.as_ref()], bump = config.vault_bump)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    /// Temporary wSOL account owned by the config PDA; created and closed within the instruction.
    #[account(
        init,
        payer = payer,
        seeds = [b"unwrap", user.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = config,
        token::token_program = token_program,
    )]
    pub unwrap: Box<InterfaceAccount<'info, TokenAccount>>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    pub user: Signer<'info>,
    #[account(seeds = [b"config", config.mint.as_ref()], bump = config.bump, has_one = mint)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [b"player", config.mint.as_ref(), user.key().as_ref()], bump = player.bump, has_one = user)]
    pub player: Account<'info, Player>,
    #[account(mut, seeds = [b"vault", config.mint.as_ref()], bump = config.vault_bump)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = mint, token::token_program = token_program)]
    pub destination: Box<InterfaceAccount<'info, TokenAccount>>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
#[instruction(round_id: u64)]
pub struct CreateRound<'info> {
    #[account(mut)]
    pub oracle: Signer<'info>,
    #[account(seeds = [b"config", config.mint.as_ref()], bump = config.bump, has_one = oracle)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        init,
        payer = oracle,
        space = 8 + Round::INIT_SPACE,
        seeds = [b"round", round_id.to_le_bytes().as_ref()],
        bump,
    )]
    pub round: Account<'info, Round>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct EnterRound<'info> {
    pub user: Signer<'info>,
    /// Pays rent for the Entry account (normally the user themselves).
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [b"config", config.mint.as_ref()], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [b"round", round.round_id.to_le_bytes().as_ref()], bump = round.bump)]
    pub round: Account<'info, Round>,
    #[account(mut, seeds = [b"player", config.mint.as_ref(), user.key().as_ref()], bump = player.bump, has_one = user)]
    pub player: Account<'info, Player>,
    /// Its existence is the one-entry-per-player guarantee.
    #[account(
        init,
        payer = payer,
        space = 8 + Entry::INIT_SPACE,
        seeds = [b"entry", round.key().as_ref(), user.key().as_ref()],
        bump,
    )]
    pub entry: Account<'info, Entry>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SettleRound<'info> {
    #[account(mut)]
    pub oracle: Signer<'info>,
    #[account(seeds = [b"config", config.mint.as_ref()], bump = config.bump, has_one = oracle, has_one = mint, has_one = treasury)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [b"round", round.round_id.to_le_bytes().as_ref()], bump = round.bump)]
    pub round: Account<'info, Round>,
    #[account(mut, seeds = [b"vault", config.mint.as_ref()], bump = config.vault_bump)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = mint, token::token_program = token_program)]
    pub treasury: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(seeds = [b"fees", config.mint.as_ref()], bump = fees.bump)]
    pub fees: Box<Account<'info, Fees>>,
    /// The creator's in-program balance (created on first fee, oracle pays the rent).
    #[account(
        init_if_needed,
        payer = oracle,
        space = 8 + Player::INIT_SPACE,
        seeds = [b"player", config.mint.as_ref(), fees.creator.as_ref()],
        bump,
    )]
    pub creator_player: Box<Account<'info, Player>>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitFees<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [b"config", config.mint.as_ref()], bump = config.bump, has_one = admin)]
    pub config: Box<Account<'info, Config>>,
    #[account(init, payer = admin, space = 8 + Fees::INIT_SPACE, seeds = [b"fees", config.mint.as_ref()], bump)]
    pub fees: Box<Account<'info, Fees>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateFees<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [b"config", config.mint.as_ref()], bump = config.bump, has_one = admin)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [b"fees", config.mint.as_ref()], bump = fees.bump)]
    pub fees: Box<Account<'info, Fees>>,
}

#[derive(Accounts)]
pub struct SetFeeTiers<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [b"config", config.mint.as_ref()], bump = config.bump, has_one = admin)]
    pub config: Box<Account<'info, Config>>,
    /// CHECK: the pool's Fees PDA, possibly still in the pre-tier layout (too short to load as
    /// `Account<Fees>`); checked by seeds and owner, then grown and rewritten in the handler.
    #[account(mut, seeds = [b"fees", config.mint.as_ref()], bump, owner = crate::ID)]
    pub fees: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct LeaveRound<'info> {
    #[account(mut)]
    pub oracle: Signer<'info>,
    #[account(seeds = [b"config", config.mint.as_ref()], bump = config.bump, has_one = oracle)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [b"round", round.round_id.to_le_bytes().as_ref()], bump = round.bump)]
    pub round: Account<'info, Round>,
    /// Closed (rent to the oracle, which paid it) so the player can rejoin later.
    #[account(
        mut,
        close = oracle,
        seeds = [b"entry", round.key().as_ref(), entry.user.as_ref()],
        bump = entry.bump,
        has_one = round,
    )]
    pub entry: Account<'info, Entry>,
    #[account(mut, seeds = [b"player", round.mint.as_ref(), entry.user.as_ref()], bump = player.bump)]
    pub player: Box<Account<'info, Player>>,
}

#[derive(Accounts)]
pub struct CancelRound<'info> {
    pub oracle: Signer<'info>,
    #[account(seeds = [b"config", config.mint.as_ref()], bump = config.bump, has_one = oracle)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [b"round", round.round_id.to_le_bytes().as_ref()], bump = round.bump)]
    pub round: Account<'info, Round>,
}

#[derive(Accounts)]
pub struct Refund<'info> {
    pub caller: Signer<'info>,
    #[account(mut, seeds = [b"round", round.round_id.to_le_bytes().as_ref()], bump = round.bump)]
    pub round: Account<'info, Round>,
    #[account(
        mut,
        seeds = [b"entry", round.key().as_ref(), entry.user.as_ref()],
        bump = entry.bump,
        has_one = round,
    )]
    pub entry: Account<'info, Entry>,
    #[account(mut, seeds = [b"player", round.mint.as_ref(), entry.user.as_ref()], bump = player.bump)]
    pub player: Account<'info, Player>,
}

// ---------------------------------------------------------------------------------------------
// Events & errors
// ---------------------------------------------------------------------------------------------

#[event]
pub struct BalanceChanged {
    pub user: Pubkey,
    pub balance: u64,
}

#[event]
pub struct RoundEntered {
    pub round: Pubkey,
    pub user: Pubkey,
    pub players: u16,
    pub pot: u64,
}

#[event]
pub struct RoundSettled {
    pub round: Pubkey,
    pub rake: u64,
    pub paid_out: u64,
}

#[error_code]
pub enum PoolError {
    #[msg("Rake above the 20% ceiling")]
    RakeTooHigh,
    #[msg("Amount must be positive")]
    ZeroAmount,
    #[msg("Program is paused")]
    Paused,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Balance too low")]
    InsufficientBalance,
    #[msg("Invalid round schedule")]
    BadSchedule,
    #[msg("Round is not open")]
    RoundClosed,
    #[msg("Entries for this round are locked")]
    RoundLocked,
    #[msg("Round is full")]
    RoundFull,
    #[msg("Round pot cap reached")]
    PotCapReached,
    #[msg("Daily entry cap reached")]
    DailyCapReached,
    #[msg("Settle deadline has passed")]
    SettleDeadlinePassed,
    #[msg("Round has not locked yet")]
    RoundNotLocked,
    #[msg("Round has no players")]
    NoPlayers,
    #[msg("Results root differs from the first settle call")]
    ResultsMismatch,
    #[msg("Expected one [entry, player] account pair per share")]
    WinnerAccountsMismatch,
    #[msg("Account is not an entrant of this round")]
    NotAnEntrant,
    #[msg("Entry already paid or refunded")]
    AlreadyPaid,
    #[msg("Payouts exceed the distributable pot")]
    PayoutExceedsPot,
    #[msg("Final settle must pay out the whole distributable pot")]
    PayoutIncomplete,
    #[msg("Refunds are only allowed for cancelled or expired rounds")]
    RefundNotAllowed,
    #[msg("Account belongs to a different currency pool")]
    WrongMint,
    #[msg("An opponent already joined; the entry is locked in")]
    OpponentJoined,
    #[msg("Fee tiers must be 0 (off) or at least 2 players, in increasing order")]
    BadFeeTiers,
}
