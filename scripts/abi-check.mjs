#!/usr/bin/env node
// ABI drift guard: fails when a generated ABI under apps/*/src/abi/ no longer matches the contract it was exported
// from. Run `cd contracts && forge build` first (the check reads contracts/out), then `pnpm abi:check`.
//
// For every `apps/<app>/src/abi/<Name>.ts` holding an `export const <Name>Abi = [...] as const;` literal (the shape
// both apps' scripts/export-abi.mjs write), the matching Foundry artifact is `contracts/out/<Name>.sol/<Name>.json`.
// Two things are compared:
//   1. The set of signatures `type:name(inputTypes)` (canonical types, tuples expanded) — an added, removed or
//      re-typed function / event / error / constructor is reported by name, which is the drift that breaks callers
//      (e.g. the app still listening for an event the vault no longer emits).
//   2. The ABI JSON itself — same signatures but different outputs, mutability, `indexed` flags or parameter names
//      still means the committed file is not what `pnpm --filter <app> abi` would write today.
// Either kind of difference exits 1. Files without a matching artifact are skipped with a note, and so are
// hand-written ABIs (ERC20.ts is a minimal surface written by the web exporter, not OpenZeppelin's full ERC20
// artifact that happens to share its name). Zero dependencies: plain Node >= 18.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "contracts", "out");
const appsDir = join(root, "apps");

/** ABI files written by hand in an exporter rather than copied from a build artifact. */
const HAND_WRITTEN = new Set(["ERC20"]);

if (!existsSync(outDir)) {
  console.error(`abi-check: ${relative(root, outDir)} not found — run \`cd contracts && forge build\` first.`);
  process.exit(1);
}

/** Canonical Solidity type of an ABI parameter: tuples become `(t1,t2)` with their array suffix kept. */
function canonicalType(param) {
  if (!param.type.startsWith("tuple")) return param.type;
  return `(${(param.components ?? []).map(canonicalType).join(",")})${param.type.slice("tuple".length)}`;
}

/** `type:name(inputTypes)` for every ABI item (constructor / fallback / receive have no name). */
function signatures(abi) {
  return new Set(abi.map((item) => `${item.type}:${item.name ?? ""}(${(item.inputs ?? []).map(canonicalType).join(",")})`));
}

/** Pull the array literal out of `export const XAbi = [...] as const;`. Returns undefined when the file has none. */
function extractAbi(source) {
  const m = source.match(/export\s+const\s+\w+\s*=\s*(\[[\s\S]*\])\s*as\s+const\s*;?\s*$/);
  if (!m) return undefined;
  return JSON.parse(m[1]);
}

/** Order-insensitive deep equality key: object keys sorted, array order kept (ABI item order is the compiler's). */
function stableKey(value) {
  if (Array.isArray(value)) return `[${value.map(stableKey).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableKey(value[k])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

let checked = 0;
let mismatches = 0;
const skipped = [];

const apps = readdirSync(appsDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

for (const app of apps) {
  const abiDir = join(appsDir, app, "src", "abi");
  if (!existsSync(abiDir)) continue;
  for (const file of readdirSync(abiDir).filter((f) => f.endsWith(".ts")).sort()) {
    const name = file.slice(0, -".ts".length);
    const rel = relative(root, join(abiDir, file));
    const abi = extractAbi(readFileSync(join(abiDir, file), "utf8"));
    if (!abi) continue; // index.ts and other re-export files: no literal to check
    if (HAND_WRITTEN.has(name)) {
      skipped.push(`${rel} (hand-written)`);
      continue;
    }
    const artifactPath = join(outDir, `${name}.sol`, `${name}.json`);
    if (!existsSync(artifactPath)) {
      skipped.push(`${rel} (no ${relative(root, artifactPath)})`);
      continue;
    }
    const artifact = JSON.parse(readFileSync(artifactPath, "utf8")).abi;
    checked++;

    const have = signatures(abi);
    const want = signatures(artifact);
    const stale = [...have].filter((s) => !want.has(s)).sort();
    const missing = [...want].filter((s) => !have.has(s)).sort();
    if (stale.length > 0 || missing.length > 0) {
      mismatches++;
      console.log(`MISMATCH ${rel}  vs  ${relative(root, artifactPath)}`);
      for (const s of stale) console.log(`  - ${s}    (in the app ABI, gone from the contract)`);
      for (const s of missing) console.log(`  + ${s}    (in the contract, missing from the app ABI)`);
    } else if (stableKey(abi) !== stableKey(artifact)) {
      mismatches++;
      console.log(`MISMATCH ${rel}  vs  ${relative(root, artifactPath)}`);
      console.log("  same signatures, but outputs / mutability / indexed flags / names / order differ");
    } else {
      console.log(`ok       ${rel}`);
    }
  }
}

for (const s of skipped) console.log(`skipped  ${s}`);
if (mismatches > 0) {
  console.log(
    `\nabi-check: ${mismatches} of ${checked} ABI file(s) out of date. Regenerate with ` +
      "`cd contracts && forge build && cd .. && pnpm --filter @dca/web abi && pnpm --filter @dca/scheduler abi`.",
  );
  process.exit(1);
}
console.log(`\nabi-check: ${checked} ABI file(s) match contracts/out (${skipped.length} skipped).`);
