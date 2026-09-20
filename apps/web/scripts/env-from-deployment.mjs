// Writes apps/web/.env.local from ../../contracts/deployments/<chainId>.json (default 31337 for anvil).
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const chainId = process.argv[2] ?? "31337";
const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(webRoot, "..", "..");
const file = join(repoRoot, "contracts", "deployments", `${chainId}.json`);
if (!existsSync(file)) {
  console.error(`missing ${file} — run the deploy script first`);
  process.exit(1);
}
const d = JSON.parse(readFileSync(file, "utf8"));
const env = [
  `NEXT_PUBLIC_CHAIN=${chainId === "4663" ? "robinhood" : "local"}`,
  `NEXT_PUBLIC_LOCAL_RPC=${process.env.LOCAL_RPC ?? "http://127.0.0.1:8545"}`,
  `NEXT_PUBLIC_RH_RPC=${process.env.RH_RPC ?? "https://rpc.robinhood.xyz"}`,
  `NEXT_PUBLIC_DIRECTORY=${d.directory}`,
  `NEXT_PUBLIC_CLAIM_HELPER=${d.claimHelper}`,
  `NEXT_PUBLIC_ZAP=${d.zap}`,
  // Local stacks only: the short-epoch TestVault. Shown when the dev server runs with NEXT_PUBLIC_SHOW_TEST_VAULT=1.
  ...(d.testVault ? [`NEXT_PUBLIC_TEST_VAULT=${d.testVault}`] : []),
  `NEXT_PUBLIC_WC_PROJECT_ID=${process.env.NEXT_PUBLIC_WC_PROJECT_ID ?? ""}`,
  `NEXT_PUBLIC_LOG_LOOKBACK=200000`,
  `NEXT_PUBLIC_BLOCKED_COUNTRIES=US,GB,CA,AU,CU,IR,KP,SY`,
  "",
].join("\n");
writeFileSync(join(webRoot, ".env.local"), env);
console.log("wrote apps/web/.env.local");
