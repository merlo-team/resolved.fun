# Security

Report vulnerabilities in the Resolved.fun site or the on-chain `resolved_pool` program.

## Contact

Prefer a private report via GitHub Security Advisories:

https://github.com/merlo-team/resolved.fun/security/advisories/new

Public / social: [@resolvedfun](https://x.com/resolvedfun)

## Scope

- On-chain program `resolved_pool` (`BJoVhD81MFEWzpbXKhuvZmh8HiA5bU3RJ9eirTbuSpNy`)
- Backend that builds and submits pool transactions
- Auth, wallet session, and fund flows on https://resolved.fun

Out of scope: third-party wallets, RPC providers, phishing copies of the site.

## Policy

We do not currently run a fixed public bug bounty. We still want responsible disclosure: please do not exploit issues, and give us a reasonable window to patch before any public write-up. We may reward reports at our discretion after we verify the issue.

## Verified builds

After each mainnet upgrade we aim to publish a [Solana verified build](https://solana.com/docs/programs/verified-builds) so Explorers / Solscan can show that the deployed binary matches https://github.com/merlo-team/resolved.fun.
