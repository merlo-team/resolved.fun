# `resolved_pool`

Anchor program that holds resolved.fun prize pots on Solana.

**GitHub (program repo):** https://github.com/merlo-team/resolved.fun

| | |
| :--- | :--- |
| **Program ID** | `BJoVhD81MFEWzpbXKhuvZmh8HiA5bU3RJ9eirTbuSpNy` |
| **Anchor** | 0.30.1 |
| **Cluster** | Mainnet (same ID also on devnet) |
| **Mint** | Wrapped SOL |
| **Solscan** | https://solscan.io/account/BJoVhD81MFEWzpbXKhuvZmh8HiA5bU3RJ9eirTbuSpNy |
| **Security.txt** | Embedded via `solana-security-txt` (visible on Solscan after upgrade) |

```bash
anchor build
anchor test
```

### Solscan Security tab + Verified badge

1. **security.txt** — already in `programs/resolved_pool` (`security_txt!`). It only appears on Solscan after you **upgrade** the mainnet program with a build that includes it.
2. **Verified** — rebuild with Docker + `solana-verify`, upgrade with that `.so`, then submit OtterSec verification against the public repo:

```bash
cargo install solana-verify --locked
cd onchain
solana-verify build
# upgrade with the verify-built .so (upgrade authority = deployer)
solana program deploy --program-id BJoVhD81MFEWzpbXKhuvZmh8HiA5bU3RJ9eirTbuSpNy \
  target/deploy/resolved_pool.so -um --keypair keys/deployer.json
# upload verify PDA + remote job (needs upgrade authority signature)
solana-verify verify-from-repo -um \
  --program-id BJoVhD81MFEWzpbXKhuvZmh8HiA5bU3RJ9eirTbuSpNy \
  https://github.com/merlo-team/resolved.fun \
  --mount-path onchain --library-name resolved_pool
solana-verify remote submit-job \
  --program-id BJoVhD81MFEWzpbXKhuvZmh8HiA5bU3RJ9eirTbuSpNy \
  --uploader <deployer-pubkey>
```

Check status: https://verify.osec.io/status/BJoVhD81MFEWzpbXKhuvZmh8HiA5bU3RJ9eirTbuSpNy

