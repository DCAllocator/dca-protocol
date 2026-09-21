// Exports the ABIs the scheduler needs from ../../contracts/out into src/abi/*.ts as `as const` for viem typing.
// Same approach as apps/web/scripts/export-abi.mjs; run `forge build` in contracts/ first.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "..", "..", "contracts", "out");
const dest = join(root, "src", "abi");
mkdirSync(dest, { recursive: true });

const contracts = [
  ["EpochKeeper", "EpochKeeper.sol/EpochKeeper.json"],
  ["PlanVault", "PlanVault.sol/PlanVault.json"],
  ["StockRegistry", "StockRegistry.sol/StockRegistry.json"],
  ["AggregatorRouter", "AggregatorRouter.sol/AggregatorRouter.json"],
  ["MorphoBlueStrategy", "MorphoBlueStrategy.sol/MorphoBlueStrategy.json"],
];

const index = [];
for (const [name, file] of contracts) {
  const json = JSON.parse(readFileSync(join(outDir, file), "utf8"));
  writeFileSync(join(dest, `${name}.ts`), `export const ${name}Abi = ${JSON.stringify(json.abi, null, 2)} as const;\n`);
  index.push(`export { ${name}Abi } from "./${name}.js";`);
}
writeFileSync(join(dest, "index.ts"), index.join("\n") + "\n");
console.log(`exported ${contracts.length} ABIs to apps/scheduler/src/abi`);
