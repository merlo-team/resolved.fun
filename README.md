<p align="center">
  <img src="brand/mark.svg" alt="resolved.fun mark" width="112" />
</p>

<p align="center">
  <img src="brand/wordmark.png" alt="resolved.fun" height="40" />
</p>

<p align="center">
  <strong>Trivia for the pot. Sealed questions, on-chain settlement.</strong><br/>
  Entry fees never sit with the server. This Anchor program holds every pot and enforces who gets paid.
</p>

<p align="center">
  <a href="https://resolved.fun"><img src="https://img.shields.io/badge/play-resolved.fun-cefa02?style=for-the-badge&labelColor=0b0d0a&color=cefa02" alt="resolved.fun" /></a>
  <a href="https://explorer.solana.com/address/BJoVhD81MFEWzpbXKhuvZmh8HiA5bU3RJ9eirTbuSpNy"><img src="https://img.shields.io/badge/cluster-mainnet-9dbf00?style=for-the-badge&labelColor=0b0d0a&color=9dbf00" alt="mainnet" /></a>
  <a href="https://www.anchor-lang.com/"><img src="https://img.shields.io/badge/Anchor-0.30.1-dcff4a?style=for-the-badge&labelColor=0b0d0a&color=dcff4a" alt="Anchor" /></a>
  <a href="https://solana.com/"><img src="https://img.shields.io/badge/Solana-mainnet-cefa02?style=for-the-badge&labelColor=0b0d0a&color=cefa02" alt="Solana" /></a>
</p>

<p align="center">
  <img src="brand/lockup.png" alt="resolved.fun lockup" width="360" />
</p>

---

## `resolved_pool`

Public source for the Solana program behind [resolved.fun](https://resolved.fun).

Players pay a SOL entry into a shared pot. Everyone gets the same question at the same moment. One miss and you're out. The last player standing takes the pot, or survivors split it. If nobody survives, the house takes it.

The game server is the **oracle** (creates rounds, scores answers, settles). This program is the **money path** the oracle cannot bend.

| | |
| :--- | :--- |
| **Program ID (mainnet)** | [`BJoVhD81MFEWzpbXKhuvZmh8HiA5bU3RJ9eirTbuSpNy`](https://explorer.solana.com/address/BJoVhD81MFEWzpbXKhuvZmh8HiA5bU3RJ9eirTbuSpNy) |
| **Anchor** | 0.30.1 |
| **Pool mint** | Wrapped SOL |
| **Fees** | House rake 0 · creator 1% / 2%@5+ / 5%@10+ |

---

## How a game works

```mermaid
flowchart TD
  A([Pick a Royale, multiplayer table, or duel]) --> C[Pay the SOL entry on-chain]
  C --> E{Enough players?}
  E -- not yet --> LV[Wait, or leave for a full refund] --> E
  E -- yes --> F[Countdown, then lock_round]
  F --> H[Same question to everyone at once]
  H --> I{Right before the clock?}
  I -- no --> X[You're out]
  I -- yes --> K
  X --> K{Still standing?}
  K -- none --> HO[[House takes the pot]]
  K -- one --> W[[Last one standing wins]]
  K -- two+ --> J{Last question?}
  J -- no --> H
  J -- yes --> S[[Survivors split the pot]]

  style A fill:#0b0d0a,stroke:#cefa02,color:#eef4e2
  style W fill:#cefa02,stroke:#9dbf00,color:#0b0d0a
  style S fill:#cefa02,stroke:#9dbf00,color:#0b0d0a
  style HO fill:#3a1010,stroke:#ff6b6b,color:#eef4e2
  style X fill:#1a1a1a,stroke:#666,color:#999
```

### Four rules (same at every table)

| # | Rule | Detail |
| :-: | :--- | :--- |
| 01 | **Same question, same moment** | Pushed to every seat at once; option order shuffled per player |
| 02 | **One miss and you're out** | Wrong answer or timeout ends your run |
| 03 | **Speed never counts** | 0.2s or the buzzer: only correct matters |
| 04 | **Last one standing takes it** | Or survivors split. If nobody survives, the house takes the pot |

---

## On-chain round lifecycle

```mermaid
stateDiagram-v2
  [*] --> Open: create_round · question Merkle root committed
  Open --> Open: enter_round
  Open --> Settling: settle_round first batch · fees taken
  Settling --> Settled: settle_round finalize · paid_out == pot minus fees
  Open --> Settled: settle_to_house · nobody survived
  Open --> Cancelled: cancel_round
  Open --> Cancelled: refund after settle_deadline
  Cancelled --> [*]: refund per entry
  Settled --> [*]

  classDef brand fill:#cefa02,stroke:#9dbf00,color:#0b0d0a
  classDef ink fill:#0b0d0a,stroke:#cefa02,color:#eef4e2
  class Open ink
  class Settled brand
```

| Instruction | Who | What it does |
| :--- | :--- | :--- |
| `create_round` | Oracle | Opens a round with fee, caps, deadlines, and a **commit** to the question set |
| `enter_round` | Player | Moves entry fee from in-program balance into the pot; creates Entry PDA |
| `leave_round` | Oracle | Lone player exits before anyone else joins: full refund, seat freed |
| `lock_round` | Oracle | Closes entries (sets `locks_at` to now) |
| `settle_round` | Oracle | Batched winner credits; final batch requires exact payout |
| `settle_to_house` | Oracle | No survivors: fees, then remainder to house balance |
| `cancel_round` | Oracle | Marks cancelled so refunds can run |
| `refund` | **Anyone** | Returns entry after cancel, or after settle deadline on an open round |

---

## Money flow

```mermaid
sequenceDiagram
  autonumber
  participant W as Player wallet
  participant P as Player PDA
  participant V as Vault PDA
  participant O as Oracle
  participant H as House

  W->>P: deposit SOL
  P->>V: enter_round · entry into pot
  Note over O: Game runs off-chain · answers scored · results root built
  O->>V: settle_round(root, salt, shares)
  V->>H: fee by table size
  V-->>P: winners credited
  P->>W: withdraw any time
```

### Fee schedule (by table size)

Fees are read from the round at settlement. The server cannot pick a different rate.

| Table size | Creator fee | Notes |
| :--- | ---: | :--- |
| 2-4 players | **1%** | Duels, small tables |
| 5-9 players | **2%** | Full multiplayer |
| 10+ players | **5%** | Mostly Royales |

Hard ceiling: house rake + creator fee at most **20%**.

---

## What the program guarantees

```mermaid
flowchart LR
  subgraph Enforced on-chain
    A[One Entry PDA per user x round]
    B[Payouts only to entrants]
    C[paid_out at most pot minus fees]
    D[Final settle: paid_out equals distributable]
    E[Refund path after cancel or deadline]
    F[Fee tiers from Fees account]
  end

  style A fill:#0b0d0a,stroke:#cefa02,color:#eef4e2
  style B fill:#0b0d0a,stroke:#cefa02,color:#eef4e2
  style C fill:#0b0d0a,stroke:#cefa02,color:#eef4e2
  style D fill:#0b0d0a,stroke:#cefa02,color:#eef4e2
  style E fill:#0b0d0a,stroke:#cefa02,color:#eef4e2
  style F fill:#0b0d0a,stroke:#cefa02,color:#eef4e2
```

The oracle runs the game (questions, scoring, sockets). It **cannot**:

- pay a wallet that never entered
- pay more than the pot allows
- finalize a settlement with leftover or overshot lamports
- skip the fee schedule stored on-chain

---

## Account model

| Account | Seeds | Purpose |
| :--- | :--- | :--- |
| `Config` | `["config", mint]` | Admin, oracle, rake, caps, pause |
| `Vault` | `["vault", mint]` | Token account holding all pots |
| `Fees` | `["fees", mint]` | Creator pubkey + tiered bps |
| `Player` | `["player", mint, user]` | In-program balance |
| `Round` | `["round", round_id]` | Pot, players, status, commit, deadlines |
| `Entry` | `["entry", round, user]` | Proof of entry; paid / refunded flags |

```mermaid
flowchart TB
  Mint((Mint · wSOL)) --> Config
  Mint --> Vault
  Mint --> Fees
  Mint --> Player
  Round --> Entry
  Player --> Entry

  style Mint fill:#cefa02,stroke:#9dbf00,color:#0b0d0a
  style Vault fill:#0b0d0a,stroke:#cefa02,color:#eef4e2
  style Round fill:#0b0d0a,stroke:#cefa02,color:#eef4e2
```

Pool accounts are seeded by the mint, so a USDC pool is a second init, not a fork.

---

## Mainnet addresses

| Role | Address |
| :--- | :--- |
| Program | [`BJoVhD81MFEWzpbXKhuvZmh8HiA5bU3RJ9eirTbuSpNy`](https://explorer.solana.com/address/BJoVhD81MFEWzpbXKhuvZmh8HiA5bU3RJ9eirTbuSpNy) |
| Config | [`DwLsBD9RMWfiUGoJC4FhVSN4M6A4jYtTiroJwUpP685N`](https://explorer.solana.com/address/DwLsBD9RMWfiUGoJC4FhVSN4M6A4jYtTiroJwUpP685N) |
| Vault | [`7YwSkavDjnyvEqARuz1qtXdJfCSpzQQudCDqg83aK5sc`](https://explorer.solana.com/address/7YwSkavDjnyvEqARuz1qtXdJfCSpzQQudCDqg83aK5sc) |
| Fees | [`FstnWK8PkzprgAhSaDmzDsfy86nDH6NbRrmUDRPgYVuV`](https://explorer.solana.com/address/FstnWK8PkzprgAhSaDmzDsfy86nDH6NbRrmUDRPgYVuV) |
| Oracle | [`GikB9ioECRURhnR2uRLJtJnFuXVxoGknuZRYEy9YTy5J`](https://explorer.solana.com/address/GikB9ioECRURhnR2uRLJtJnFuXVxoGknuZRYEy9YTy5J) |
| House | [`6PQ9ULgtZnsvCsTRinDRdiVaHayuAykn15Do5WSMBKm7`](https://explorer.solana.com/address/6PQ9ULgtZnsvCsTRinDRdiVaHayuAykn15Do5WSMBKm7) |

---

## Build & test

```bash
anchor build
anchor test
```

Requires Rust, Solana CLI, Anchor **0.30.1**, and Node 20+.

---

## Security notes

- Admin / upgrade authority stays offline for mainnet. Never on the production host.
- The oracle key is the only hot signer the game server needs.
- Questions are committed as a Merkle root before play; salt revealed after settle.
- Overflow checks are on in the program crate.

Found something? Open an issue or reach out on [X](https://x.com/resolvedfun).

---

## License

Proprietary for now. Contact before reuse. Source is public so anyone can verify the money rules.

---

<p align="center">
  <img src="brand/mark.svg" width="48" alt="" />
  <br/>
  <sub>built for the pot · <a href="https://resolved.fun">resolved.fun</a></sub>
</p>
