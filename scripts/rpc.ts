/** Shared RPC resolution for onchain scripts: QuickNode first, never Helius. */
export function rpcHttp(cluster: "mainnet" | "devnet" = "mainnet") {
  return (
    process.env.QUICKNODE_RPC_URL ||
    process.env.RPC_URL ||
    process.env.SOLANA_RPC ||
    (cluster === "mainnet" ? "https://api.mainnet-beta.solana.com" : "https://api.devnet.solana.com")
  );
}

export function rpcWs(cluster: "mainnet" | "devnet" = "mainnet") {
  const http = rpcHttp(cluster);
  return process.env.QUICKNODE_WSS_URL || process.env.RPC_WSS || http.replace(/^http/, "ws");
}
