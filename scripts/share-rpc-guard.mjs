#!/usr/bin/env node
// JSON-RPC guard in front of anvil for `pnpm share` (scripts/share.sh). The tunnel points here, never at anvil itself:
// anvil's accounts are unlocked (eth_sendTransaction from the deployer would own the protocol) and its anvil_* / evm_*
// methods rewrite the chain. So only requests carrying SHARE_RPC_KEY — which the hosted app's /api/rpc route adds —
// get through, and only the reads and eth_sendRawTransaction a dapp and a browser wallet need. In a batch, each denied
// call gets its own error and the rest is forwarded.
//
//   SHARE_RPC_KEY=… node scripts/share-rpc-guard.mjs     # GUARD_PORT (8547) → UPSTREAM (http://127.0.0.1:8545)
import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";

const PORT = Number(process.env.GUARD_PORT ?? 8547);
const UPSTREAM = process.env.UPSTREAM ?? "http://127.0.0.1:8545";
const KEY = Buffer.from(process.env.SHARE_RPC_KEY ?? "");
if (KEY.length < 16) {
  console.error("SHARE_RPC_KEY (at least 16 characters) is required");
  process.exit(1);
}

const ALLOWED = new Set([
  // node and chain
  "eth_chainId", "net_version", "net_listening", "web3_clientVersion", "eth_syncing", "eth_protocolVersion",
  // blocks, transactions, state
  "eth_blockNumber", "eth_getBlockByNumber", "eth_getBlockByHash", "eth_getBlockReceipts",
  "eth_getBlockTransactionCountByNumber", "eth_getBlockTransactionCountByHash",
  "eth_getTransactionByHash", "eth_getTransactionByBlockNumberAndIndex", "eth_getTransactionByBlockHashAndIndex",
  "eth_getTransactionReceipt", "eth_getTransactionCount", "eth_getBalance", "eth_getCode", "eth_getStorageAt",
  "eth_getProof", "eth_call", "eth_estimateGas", "eth_createAccessList",
  // gas
  "eth_gasPrice", "eth_maxPriorityFeePerGas", "eth_feeHistory", "eth_blobBaseFee",
  // logs and filters
  "eth_getLogs", "eth_newFilter", "eth_newBlockFilter", "eth_newPendingTransactionFilter",
  "eth_getFilterChanges", "eth_getFilterLogs", "eth_uninstallFilter",
  // transactions the tester's own wallet signed
  "eth_sendRawTransaction",
]);
const MAX_BODY = 512 * 1024;
const MAX_BATCH = 100;

const keyOk = (got) => {
  const g = Buffer.from(String(got ?? ""));
  return g.length === KEY.length && timingSafeEqual(g, KEY);
};
const errorFor = (id, code, message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
const denied = (call) => errorFor(call?.id, -32601, `Not available on the shared test chain: ${call?.method}`);

createServer(async (req, res) => {
  const send = (status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.method !== "POST") return send(405, { error: "POST only" });
  if (!keyOk(req.headers["x-share-key"])) return send(401, { error: "unauthorized" });

  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > MAX_BODY) return send(413, errorFor(null, -32600, "Request too large"));
  }
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return send(400, errorFor(null, -32700, "Parse error"));
  }
  const batch = Array.isArray(payload);
  const calls = batch ? payload : [payload];
  if (calls.length === 0 || calls.length > MAX_BATCH) return send(400, errorFor(null, -32600, "Bad batch size"));

  const ok = calls.filter((c) => ALLOWED.has(c?.method));
  for (const c of calls) if (!ALLOWED.has(c?.method)) console.log(`[guard] ${new Date().toISOString()} denied ${c?.method}`);

  let answers = [];
  if (ok.length) {
    try {
      const r = await fetch(UPSTREAM, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(batch ? ok : ok[0]),
        signal: AbortSignal.timeout(20_000),
      });
      const out = await r.json();
      answers = Array.isArray(out) ? out : [out];
    } catch {
      return send(502, errorFor(null, -32603, "The test chain (anvil) is not answering"));
    }
  }
  if (!batch) return send(200, ok.length ? answers[0] : denied(calls[0]));
  const byId = new Map(answers.map((a) => [JSON.stringify(a?.id), a]));
  send(200, calls.map((c) => (ALLOWED.has(c?.method) ? byId.get(JSON.stringify(c.id)) ?? errorFor(c.id, -32603, "No answer") : denied(c))));
}).listen(PORT, "127.0.0.1", () => console.log(`[guard] 127.0.0.1:${PORT} → ${UPSTREAM} (key required, ${ALLOWED.size} methods)`));
