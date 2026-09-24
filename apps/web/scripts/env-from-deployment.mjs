// Writes apps/web/.env.local from ../../contracts/deployments/<chainId>.json (default 31337 for anvil).
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { keccak256 } from "viem";

// The canonical Multicall3 (see src/lib/chain.ts). scripts/fork.sh installs it on the local anvil.
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const MULTICALL3_CODEHASH = "0xd5c15df687b16f2ff992fc8d767b4216323184a2bbc6ee2f9c398c318e770891";

/** True when the node at `rpc` has the canonical Multicall3 code (false if it has none, other code, or no answer). */
async function hasMulticall3(rpc) {
  try {
    const res = await fetch(rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getCode", params: [MULTICALL3, "latest"] }),
      signal: AbortSignal.timeout(5_000),
    });
    const { result } = await res.json();
    return typeof result === "string" && result !== "0x" && keccak256(result) === MULTICALL3_CODEHASH;
  } catch {
    return false;
  }
}

const chainId = process.argv[2] ?? "31337";
const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(webRoot, "..", "..");
const file = join(repoRoot, "contracts", "deployments", `${chainId}.json`);
if (!existsSync(file)) {
  console.error(`missing ${file} — run the deploy script first`);
  process.exit(1);
}
const d = JSON.parse(readFileSync(file, "utf8"));
const localRpc = process.env.LOCAL_RPC ?? "http://127.0.0.1:8545";
// Local stacks only: the app declares Multicall3 on anvil (NEXT_PUBLIC_LOCAL_MULTICALL3=1) only when the node really
// has it — declared without the code, every batched read in the app would fail.
const localMulticall3 = chainId === "31337" && (await hasMulticall3(localRpc));
const env = [
  `NEXT_PUBLIC_CHAIN=${chainId === "4663" ? "robinhood" : "local"}`,
  `NEXT_PUBLIC_LOCAL_RPC=${localRpc}`,
  ...(localMulticall3 ? ["NEXT_PUBLIC_LOCAL_MULTICALL3=1"] : []),
  `NEXT_PUBLIC_RH_RPC=${process.env.RH_RPC ?? "https://rpc.mainnet.chain.robinhood.com"}`,
  `NEXT_PUBLIC_DIRECTORY=${d.directory}`,
  `NEXT_PUBLIC_CLAIM_HELPER=${d.claimHelper}`,
  `NEXT_PUBLIC_ZAP=${d.zap}`,
  `NEXT_PUBLIC_KEEPER=${d.keeper}`,
  // Local stacks only: the short-epoch TestVault. Shown when the dev server runs with NEXT_PUBLIC_SHOW_TEST_VAULT=1.
  ...(d.testVault ? [`NEXT_PUBLIC_TEST_VAULT=${d.testVault}`] : []),
  `NEXT_PUBLIC_WC_PROJECT_ID=${process.env.NEXT_PUBLIC_WC_PROJECT_ID ?? ""}`,
  `NEXT_PUBLIC_LOG_LOOKBACK=200000`,
  `NEXT_PUBLIC_BLOCKED_COUNTRIES=US,GB,CA,AU,CU,IR,KP,SY`,
  // "Buy $DCA" destination off-site (Pons) and the flag that forces the Buy tab on a real chain; see .env.local.example.
  `# NEXT_PUBLIC_BUY_DCA_URL=`,
  `# NEXT_PUBLIC_ENABLE_BUY_TAB=1`,
  "",
].join("\n");
writeFileSync(join(webRoot, ".env.local"), env);
console.log("wrote apps/web/.env.local");
if (chainId === "31337")
  console.log(
    localMulticall3
      ? `Multicall3 found at ${MULTICALL3} on ${localRpc}: NEXT_PUBLIC_LOCAL_MULTICALL3=1 (contract reads are batched)`
      : `no Multicall3 at ${MULTICALL3} on ${localRpc}: NEXT_PUBLIC_LOCAL_MULTICALL3 left out, so every contract read is its own eth_call (\`pnpm fork\` installs it)`,
  );
