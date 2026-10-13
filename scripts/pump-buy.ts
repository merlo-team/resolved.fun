/**
 * Watch a creator wallet over QuickNode WSS; when they create a pump.fun token, buy
 * immediately from your wallets with robust retries.
 *
 * Uses logsSubscribe / transactionSubscribe @ commitment "processed" when the RPC supports it.
 *
 * Do NOT run until wallets are funded and amounts are set. Keys stay local (onchain/keys/).
 *
 *   QUICKNODE_RPC_URL=… QUICKNODE_WSS_URL=… \
 *   npx tsx onchain/scripts/pump-buy.ts \
 *     --wallet onchain/keys/w2.json:1 \
 *     --wallet onchain/keys/w3.json:1 \
 *     --slippage 25 \
 *     --priority 0.003
 *
 * Optional:
 *   --creator <pubkey>   default 6PQ9ULgtZnsvCsTRinDRdiVaHayuAykn15Do5WSMBKm7
 *   --mint <CA>          skip watch; buy this mint now (same retry loop)
 *   --retries 60         buy attempts per wallet (default 60)
 *   --retry-ms 200       delay between failed attempts
 *   --pool pump
 */
import { Connection, Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { rpcHttp, rpcWs } from "./rpc.js";

const PORTAL = "https://pumpportal.fun/api/trade-local";
const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const DEFAULT_CREATOR = "6PQ9ULgtZnsvCsTRinDRdiVaHayuAykn15Do5WSMBKm7";

type WalletBuy = { label: string; kp: Keypair; sol: number };

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const creator = arg("creator") ?? DEFAULT_CREATOR;
const mintArg = arg("mint");
const slippage = Number(arg("slippage") ?? 25);
const priorityFee = Number(arg("priority") ?? 0.003);
const retries = Number(arg("retries") ?? 60);
const retryMs = Number(arg("retry-ms") ?? 200);
const pool = arg("pool") ?? "pump";

const walletArgs = process.argv.flatMap((a, i) => (a === "--wallet" ? [process.argv[i + 1]] : []));
if (walletArgs.length === 0) {
  console.error(
    "usage: pump-buy.ts --wallet path.json:sol [--wallet …] [--creator …] [--mint CA] [--slippage 25] [--priority 0.003]",
  );
  process.exit(1);
}

const http = rpcHttp("mainnet");
const wsUrl = rpcWs("mainnet");
if (!process.env.QUICKNODE_WSS_URL && !process.env.RPC_WSS) {
  console.warn("warning: set QUICKNODE_WSS_URL (or RPC_WSS) for websocket subscribe");
}

const conn = new Connection(http, { commitment: "processed", wsEndpoint: wsUrl });

function loadWallet(spec: string): WalletBuy {
  const [pathPart, solPart] = spec.split(":");
  const sol = Number(solPart);
  if (!(sol > 0)) throw new Error(`bad sol amount in ${spec}`);
  const raw = JSON.parse(readFileSync(resolve(pathPart), "utf8"));
  const kp = Keypair.fromSecretKey(Uint8Array.from(raw));
  const pk = kp.publicKey.toBase58();
  return { label: `${pk.slice(0, 4)}…${pk.slice(-4)}`, kp, sol };
}

const wallets = walletArgs.map(loadWallet);

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function short(pk: string) {
  return `${pk.slice(0, 4)}…${pk.slice(-4)}`;
}

async function buildAndSend(mint: string, w: WalletBuy): Promise<string> {
  const res = await fetch(PORTAL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      publicKey: w.kp.publicKey.toBase58(),
      action: "buy",
      mint,
      amount: w.sol,
      denominatedInSol: "true",
      slippage,
      priorityFee,
      pool,
    }),
  });
  if (!res.ok) throw new Error(`portal ${res.status}: ${(await res.text()).slice(0, 240)}`);
  const tx = VersionedTransaction.deserialize(new Uint8Array(await res.arrayBuffer()));
  tx.sign([w.kp]);
  return conn.sendTransaction(tx, { skipPreflight: true, maxRetries: 2 });
}

async function buyWalletWithRetries(mint: string, w: WalletBuy) {
  const need = Math.round((w.sol + priorityFee + 0.015) * 1e9);
  const bal = await conn.getBalance(w.kp.publicKey, "processed");
  if (bal < need) throw new Error(`${w.label} underfunded: ${bal / 1e9} SOL, need ~${need / 1e9}`);

  let lastErr: unknown;
  for (let i = 1; i <= retries; i++) {
    try {
      const sig = await buildAndSend(mint, w);
      console.log(`[ok] ${w.label} ${w.sol} SOL (#${i}) → https://solscan.io/tx/${sig}`);
      return sig;
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[retry ${i}/${retries}] ${w.label}: ${msg}`);
      await sleep(retryMs);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function buyAll(mint: string) {
  console.log(`buying mint ${mint}`);
  const results = await Promise.allSettled(wallets.map((w) => buyWalletWithRetries(mint, w)));
  let ok = 0;
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === "fulfilled") ok++;
    else console.error(`[fail] ${wallets[i].label}:`, r.reason?.message ?? r.reason);
  }
  console.log(`finished ${ok}/${wallets.length} wallets for ${mint}`);
  if (ok === 0) throw new Error("all buys failed");
}

function accountKeys(message: any): string[] {
  const keys = message?.accountKeys ?? message?.staticAccountKeys ?? [];
  return keys.map((k: any) => (typeof k === "string" ? k : k.pubkey ?? k.toString()));
}

function looksLikeCreate(logs: string[] | null | undefined): boolean {
  if (!logs?.length) return false;
  const blob = logs.join("\n");
  return (
    /Instruction: Create(V2)?\b/i.test(blob) ||
    /Instruction: InitializeMint2\b/i.test(blob) ||
    /Program log: Instruction: Create/i.test(blob)
  );
}

function mintFromCreateTx(result: any): string | null {
  const tx = result?.transaction?.transaction ?? result?.transaction;
  const meta = result?.transaction?.meta ?? result?.meta;
  const message = tx?.message;
  if (!message) return null;
  const logs: string[] = meta?.logMessages ?? [];
  if (!looksLikeCreate(logs)) return null;

  const keys = accountKeys(message);
  if (!keys.includes(creator) || !keys.includes(PUMP_PROGRAM)) return null;

  // Classic pump create: fee payer / user = keys[0], mint = keys[1]
  const candidate = keys[1];
  if (candidate && candidate !== creator && candidate !== PUMP_PROGRAM) {
    try {
      new PublicKey(candidate);
      return candidate;
    } catch {
      /* fall through */
    }
  }

  // Fallback: first non-program, non-creator, non-system key that isn't a known sysvar
  const skip = new Set([
    creator,
    PUMP_PROGRAM,
    "11111111111111111111111111111111",
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
    "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
    "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s",
    "ComputeBudget111111111111111111111111111111",
    "SysvarRent111111111111111111111111111111111",
    "Sysvar1nstructions1111111111111111111111111",
  ]);
  for (const k of keys) {
    if (skip.has(k)) continue;
    try {
      new PublicKey(k);
      return k;
    } catch {
      /* next */
    }
  }
  return null;
}

function watchCreator(): Promise<string> {
  return new Promise((resolveMint, reject) => {
    if (typeof WebSocket === "undefined") {
      reject(new Error("WebSocket not available — use Node 22+"));
      return;
    }

    let settled = false;
    let ping: ReturnType<typeof setInterval> | undefined;
    const socket = new WebSocket(wsUrl);

    const finish = (mint: string) => {
      if (settled) return;
      settled = true;
      if (ping) clearInterval(ping);
      try {
        socket.close();
      } catch {
        /* ignore */
      }
      resolveMint(mint);
    };

    socket.addEventListener("open", () => {
      console.log(`quicknode ws open → watching creator ${short(creator)} + pump`);
      socket.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "transactionSubscribe",
          params: [
            {
              failed: false,
              vote: false,
              // both must appear: creator wallet AND pump program
              accountRequired: [creator, PUMP_PROGRAM],
            },
            {
              commitment: "processed",
              encoding: "jsonParsed",
              transactionDetails: "full",
              showRewards: false,
              maxSupportedTransactionVersion: 1,
            },
          ],
        }),
      );
      ping = setInterval(() => {
        try {
          // keep-alive; browsers use ping frames, Node may need a noop send
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 99 }));
        } catch {
          /* ignore */
        }
      }, 15_000);
    });

    socket.addEventListener("message", (ev) => {
      let msg: any;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.method !== "transactionNotification") return;
      const result = msg.params?.result;
      if (!result) return;
      const mint = mintFromCreateTx(result);
      if (!mint) return;
      console.log(`CREATE seen · mint ${mint} · sig ${result.signature ?? "?"}`);
      finish(mint);
    });

    socket.addEventListener("error", (ev) => {
      if (!settled) {
        settled = true;
        if (ping) clearInterval(ping);
        reject(new Error(`websocket error: ${String((ev as ErrorEvent).message ?? ev)}`));
      }
    });

    socket.addEventListener("close", () => {
      if (!settled) {
        settled = true;
        if (ping) clearInterval(ping);
        reject(new Error("websocket closed before create"));
      }
    });
  });
}

console.log(`creator ${creator}`);
console.log(`wallets ${wallets.map((w) => `${w.label}=${w.sol}SOL`).join(", ")}`);
console.log(`slippage ${slippage}% · priority ${priorityFee} SOL · retries ${retries}×${retryMs}ms · pool ${pool}`);

if (mintArg) {
  await buyAll(mintArg);
  process.exit(0);
}

const mint = await watchCreator();
await buyAll(mint);
process.exit(0);
