// Exports ABIs from ../../contracts/out into src/abi/*.ts as `as const` for viem/wagmi typing.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(webRoot, "..", "..");
const outDir = join(repoRoot, "contracts", "out");
const dest = join(webRoot, "src", "abi");
mkdirSync(dest, { recursive: true });

const contracts = [
  ["PlanVault", "PlanVault.sol/PlanVault.json"],
  ["StockRegistry", "StockRegistry.sol/StockRegistry.json"],
  ["VaultDirectory", "VaultDirectory.sol/VaultDirectory.json"],
  ["ClaimHelper", "ClaimHelper.sol/ClaimHelper.json"],
  ["AggregatorRouter", "AggregatorRouter.sol/AggregatorRouter.json"],
  ["Zap", "Zap.sol/Zap.json"],
  ["EpochKeeper", "EpochKeeper.sol/EpochKeeper.json"],
  ["MorphoBlueStrategy", "MorphoBlueStrategy.sol/MorphoBlueStrategy.json"],
];

// Minimal ERC-20 surface used by the app.
const erc20 = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "o", type: "address" }, { name: "s", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "s", type: "address" }, { name: "v", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
];

const index = [];
for (const [name, file] of contracts) {
  const json = JSON.parse(readFileSync(join(outDir, file), "utf8"));
  writeFileSync(join(dest, `${name}.ts`), `export const ${name}Abi = ${JSON.stringify(json.abi, null, 2)} as const;\n`);
  index.push(`export { ${name}Abi } from "./${name}";`);
}
writeFileSync(join(dest, "ERC20.ts"), `export const ERC20Abi = ${JSON.stringify(erc20, null, 2)} as const;\n`);
index.push(`export { ERC20Abi } from "./ERC20";`);
writeFileSync(join(dest, "index.ts"), index.join("\n") + "\n");
console.log(`exported ${contracts.length + 1} ABIs to apps/web/src/abi`);
