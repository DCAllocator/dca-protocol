#!/usr/bin/env node
/**
 * RPC latency proxy for the local chain. Sits between the web app and anvil and makes transactions behave the
 * way they do on a real network, so the in-flight states of the UI (wallet prompt, pending, failed) can be seen
 * and tested end to end. No dependencies.
 *
 *   latency ± jitter  every RPC call takes this long (ms)
 *   sign              the test wallet takes this long to "sign" each eth_sendTransaction (ms)
 *   blockTime         seconds between blocks (anvil interval mining); 0 = mine each tx at once (anvil's default),
 *                     "manual" = mine nothing until `curl localhost:8555/__latency/mine`
 *   reject            share (0-1) of sends answered "User rejected the request." (4001) once the sign delay is up
 *   revert            share (0-1) of sends given a gas limit that runs out → mined, receipt status "reverted"
 *   drop              share (0-1) of sent txs evicted from the mempool → never mined (needs blockTime ≠ 0)
 *
 *   pnpm latency                          # preset "realistic" on :8555, forwarding to anvil on :8545
 *   pnpm latency slow                     # presets: off | realistic | slow | chaos
 *   pnpm latency chaos drop=0 sign=1500   # a preset plus overrides
 *   PORT=8556 UPSTREAM=http://127.0.0.1:8546 pnpm latency
 *
 * Point the app at it with NEXT_PUBLIC_LOCAL_RPC=http://127.0.0.1:8555 (`pnpm dev:latency` does that, on :3004),
 * then change the knobs live, without restarting either:
 *
 *   curl 'localhost:8555/__latency'                        # settings + counters
 *   curl 'localhost:8555/__latency?preset=slow'
 *   curl 'localhost:8555/__latency?sign=6000&reject=1'
 *   curl 'localhost:8555/__latency/mine'                   # mine one block (for blockTime=manual)
 *
 * blockTime switches the mining mode of the anvil node itself, so every client of that node (other dev servers,
 * the scheduler) sees the same block cadence. On exit the proxy puts anvil back on automine if that is how it
 * found it. sign / reject / revert act on the local "Use test wallet", which sends eth_sendTransaction through the
 * app's RPC; a browser wallet signs by itself and broadcasts over its own RPC, so only latency and blockTime reach
 * it (and drop, if the wallet's network is pointed at this proxy too).
 */
import http from "node:http";

const PORT = Number(process.env.PORT ?? 8555);
const UPSTREAM = process.env.UPSTREAM ?? "http://127.0.0.1:8545";

const PRESETS = {
  off: { latency: 0, jitter: 0, sign: 0, blockTime: 0, reject: 0, revert: 0, drop: 0 },
  realistic: { latency: 150, jitter: 100, sign: 3000, blockTime: 2, reject: 0, revert: 0, drop: 0 },
  slow: { latency: 600, jitter: 400, sign: 8000, blockTime: 12, reject: 0, revert: 0, drop: 0 },
  chaos: { latency: 300, jitter: 250, sign: 2500, blockTime: 4, reject: 0.2, revert: 0.2, drop: 0.1 },
};
const MS = ["latency", "jitter", "sign"];
const SHARES = ["reject", "revert", "drop"];

// ── settings ────────────────────────────────────────────────────────────────────────────────────────

/** Applies `[key, value]` pairs (argv or query string) to `base`. A preset is applied first, whatever its position. */
function parse(pairs, base) {
  const next = { ...base };
  const ordered = [...pairs].sort(([a], [b]) => (b === "preset") - (a === "preset"));
  for (const [key, raw] of ordered) {
    const num = () => {
      const n = Number(raw);
      if (raw === "" || !Number.isFinite(n)) throw new Error(`${key}: "${raw}" is not a number`);
      return n;
    };
    if (key === "preset") {
      if (!PRESETS[raw]) throw new Error(`unknown preset "${raw}" (${Object.keys(PRESETS).join(" | ")})`);
      Object.assign(next, PRESETS[raw]);
    } else if (key === "blockTime") {
      // anvil's interval miner takes whole seconds.
      next.blockTime = raw === "manual" ? "manual" : raw === "auto" ? 0 : Math.max(0, Math.round(num()));
    } else if (MS.includes(key)) next[key] = Math.max(0, num());
    else if (SHARES.includes(key)) next[key] = Math.min(1, Math.max(0, num()));
    else throw new Error(`unknown setting "${key}" (preset, ${[...MS, "blockTime", ...SHARES].join(", ")})`);
  }
  return next;
}

const describe = (c) =>
  [
    `rpc ${c.latency}±${c.jitter} ms`,
    `wallet ${c.sign} ms`,
    c.blockTime === "manual" ? "manual mining" : c.blockTime ? `a block every ${c.blockTime}s` : "instant mining",
    ...SHARES.filter((k) => c[k]).map((k) => `${k} ${Math.round(c[k] * 100)}%`),
  ].join(" · ");

// ── upstream ────────────────────────────────────────────────────────────────────────────────────────

let rpcId = 0;
async function forward(msg) {
  const res = await fetch(UPSTREAM, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(msg) });
  return res.json();
}
async function upstream(method, params = []) {
  const { result, error } = await forward({ jsonrpc: "2.0", id: `latency-${++rpcId}`, method, params });
  if (error) throw new Error(`${method}: ${error.message}`);
  return result;
}

// ── mining ──────────────────────────────────────────────────────────────────────────────────────────

let initialAutomine = true;
/** The blockTime last pushed to anvil; undefined until the proxy has changed anything. */
let applied;

async function syncMining() {
  const bt = cfg.blockTime;
  if (bt === applied) return;
  if (applied === undefined && bt === 0 && initialAutomine) return; // already what anvil does
  if (bt === 0) {
    await upstream("evm_setAutomine", [true]);
    await upstream("evm_mine"); // anything left pending from manual / interval mode
  } else {
    // 0 = MiningMode::None (manual). This also replaces automine, which evm_setAutomine(false) would not do from interval mode.
    await upstream("evm_setIntervalMining", [bt === "manual" ? 0 : bt]);
  }
  applied = bt;
}

// ── transactions ────────────────────────────────────────────────────────────────────────────────────

const stats = { sent: 0, rejected: 0, reverted: 0, dropped: 0, mined: 0 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hit = (p) => p > 0 && Math.random() < p;
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "?");
const clock = () => new Date().toISOString().slice(11, 23);
const log = (...a) => console.log(`\x1b[2m${clock()}\x1b[0m`, ...a);

/**
 * A gas limit that just covers the intrinsic cost (and the EIP-7623 calldata floor, where the node enforces it)
 * plus ~2k: the node accepts the tx, and it runs out of gas at its first cold storage read (2,100). Mined, reverted.
 */
function doomedGas(tx) {
  const data = String(tx.data ?? tx.input ?? "0x").slice(2);
  let zero = 0;
  let nonzero = 0;
  for (let i = 0; i < data.length; i += 2) data.slice(i, i + 2) === "00" ? zero++ : nonzero++;
  const intrinsic = 21_000 + 4 * zero + 16 * nonzero + (tx.to ? 0 : 32_000 + 2 * Math.ceil(data.length / 64));
  const floor = 21_000 + 10 * (zero + 4 * nonzero);
  return `0x${(Math.max(intrinsic, floor) + 2_000).toString(16)}`;
}

/** Logs when a sent tx lands (or that it never did), so the proxy's console reads as a timeline. */
async function follow(hash, tag, t0) {
  for (let i = 0; i < 1_200; i++) {
    await sleep(500);
    const r = await upstream("eth_getTransactionReceipt", [hash]).catch(() => undefined);
    if (r) {
      stats.mined++;
      const ok = r.status === "0x1";
      log(tag, `${ok ? "\x1b[32mmined\x1b[0m" : "\x1b[31mmined, reverted\x1b[0m"} in block ${Number(r.blockNumber)}, ${((Date.now() - t0) / 1000).toFixed(1)}s after send`);
      return;
    }
    if (!(await upstream("eth_getTransactionByHash", [hash]).catch(() => undefined))) return; // dropped (already logged)
  }
}

async function handle(msg) {
  const method = msg?.method;
  if (method !== "eth_sendTransaction" && method !== "eth_sendRawTransaction") return forward(msg);

  const n = ++stats.sent;
  const tx = method === "eth_sendTransaction" ? (msg.params?.[0] ?? {}) : undefined;
  const tag = `\x1b[1mtx#${n}\x1b[0m ${tx ? `${short(tx.from)} → ${short(tx.to)} ${String(tx.data ?? tx.input ?? "").slice(0, 10)}` : "raw"}`;
  let doomed = false;
  if (tx) {
    if (cfg.sign) {
      log(tag, `in the wallet for ${cfg.sign} ms`);
      await sleep(cfg.sign);
    }
    if (hit(cfg.reject)) {
      stats.rejected++;
      log(tag, "\x1b[33mrejected in the wallet\x1b[0m");
      return { jsonrpc: "2.0", id: msg.id, error: { code: 4001, message: "User rejected the request." } };
    }
    if (hit(cfg.revert)) {
      doomed = true;
      msg = { ...msg, params: [{ ...tx, gas: doomedGas(tx) }] };
    }
  }

  const t0 = Date.now();
  const res = await forward(msg);
  const hash = res.result;
  if (typeof hash !== "string") {
    log(tag, `\x1b[31mnode refused it: ${res.error?.message}\x1b[0m`);
    return res;
  }
  if (doomed) stats.reverted++;
  log(tag, `sent ${short(hash)}${doomed ? " \x1b[33m(gas cut: will revert)\x1b[0m" : ""}`);
  if (hit(cfg.drop)) {
    if (cfg.blockTime === 0) log(tag, "drop skipped: with instant mining it is already mined");
    else if (await upstream("anvil_dropTransaction", [hash]).catch(() => null)) {
      stats.dropped++;
      log(tag, "\x1b[33mdropped from the mempool: it will never be mined\x1b[0m");
    }
  }
  follow(hash, tag, t0);
  return res;
}

// ── server ──────────────────────────────────────────────────────────────────────────────────────────

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function control(url, res) {
  try {
    if (url.pathname === "/__latency/mine") {
      await upstream("evm_mine");
      const block = Number(await upstream("eth_blockNumber"));
      log(`mined block ${block}`);
      return send(res, 200, { mined: block });
    }
    const pairs = [...url.searchParams];
    if (pairs.length) {
      cfg = parse(pairs, cfg);
      await syncMining();
      log(`\x1b[36m${describe(cfg)}\x1b[0m`);
    }
    send(res, 200, { ...cfg, upstream: UPSTREAM, stats });
  } catch (e) {
    send(res, 400, { error: e.message });
  }
}

const server = http.createServer(async (req, res) => {
  // anvil answers with `*`, and the app calls the RPC cross-origin.
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "*");
  res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  res.setHeader("access-control-max-age", "86400");
  if (req.method === "OPTIONS") return res.writeHead(204).end();

  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname.startsWith("/__latency")) return control(url, res);
  if (req.method !== "POST") return send(res, 405, { error: "JSON-RPC over POST; settings at /__latency" });

  const chunks = [];
  for await (const c of req) chunks.push(c);
  let payload;
  try {
    payload = JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    return send(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
  }

  await sleep(Math.max(0, cfg.latency + (Math.random() * 2 - 1) * cfg.jitter));
  try {
    send(res, 200, Array.isArray(payload) ? await Promise.all(payload.map(handle)) : await handle(payload));
  } catch (e) {
    send(res, 502, { jsonrpc: "2.0", id: payload?.id ?? null, error: { code: -32603, message: `latency proxy: ${UPSTREAM} failed: ${e.message}` } });
  }
});

// ── start / stop ────────────────────────────────────────────────────────────────────────────────────

let cfg;
try {
  // `pnpm latency slow sign=500` / `--sign=500` / `--sign 500`
  const args = process.argv.slice(2);
  const pairs = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i].replace(/^--/, "");
    if (a.includes("=")) pairs.push(a.split(/=(.*)/s).slice(0, 2));
    else if (PRESETS[a]) pairs.push(["preset", a]);
    else if (args[i].startsWith("--") && i + 1 < args.length) pairs.push([a, args[++i]]);
    else throw new Error(`unknown argument "${args[i]}"`);
  }
  cfg = parse(pairs.some(([k]) => k === "preset") ? pairs : [["preset", "realistic"], ...pairs], PRESETS.off);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

try {
  const chainId = Number(await upstream("eth_chainId"));
  if (chainId !== 31337) throw new Error(`chain id ${chainId} is not the local anvil (31337); this proxy only drives anvil`);
  initialAutomine = await upstream("anvil_getAutomine");
} catch (e) {
  console.error(`Cannot use ${UPSTREAM}: ${e.cause?.code ?? e.message}. Start the local chain first (pnpm fork).`);
  process.exit(1);
}

server.on("error", (e) => {
  console.error(e.code === "EADDRINUSE" ? `Port ${PORT} is in use; run with PORT=<other>.` : e.message);
  process.exit(1);
});
server.listen(PORT, "127.0.0.1", async () => {
  try {
    await syncMining();
  } catch (e) {
    console.error(`Could not set anvil's mining mode: ${e.message}`);
  }
  console.log(`\n\x1b[1mRPC latency proxy\x1b[0m  http://127.0.0.1:${PORT}  →  ${UPSTREAM}`);
  console.log(`  \x1b[36m${describe(cfg)}\x1b[0m`);
  console.log(`\n  app:     NEXT_PUBLIC_LOCAL_RPC=http://127.0.0.1:${PORT}   (pnpm dev:latency → http://localhost:3004)`);
  console.log(`  change:  curl 'localhost:${PORT}/__latency?preset=slow'   presets: ${Object.keys(PRESETS).join(" | ")}`);
  console.log(`           curl 'localhost:${PORT}/__latency?sign=5000&reject=0.5&blockTime=manual'`);
  console.log(`  mine:    curl localhost:${PORT}/__latency/mine\n`);
});

let stopping = false;
async function stop() {
  if (stopping) return process.exit(1);
  stopping = true;
  if (applied !== undefined && !initialAutomine) {
    console.log("\nanvil was not on automine when the proxy started; its mining mode is left as the proxy last set it");
  } else if (applied !== undefined && applied !== 0) {
    await upstream("evm_setAutomine", [true]).then(() => upstream("evm_mine")).then(
      () => console.log("\nanvil is back on automine"),
      () => console.log("\ncould not put anvil back on automine: `cast rpc evm_setAutomine true`"),
    );
  }
  process.exit(0);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
