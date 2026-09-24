import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Address, Hex } from "viem";

/** Package root (apps/scheduler), both from src/ (tsx) and dist/ (node). */
export const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
/** Monorepo root; only used to find contracts/deployments/<chainId>.json when KEEPER_ADDRESS is unset. */
export const REPO_ROOT = join(PKG_ROOT, "..", "..");

export type Config = {
  rpcUrl: string;
  privateKey?: Hex;
  keeper?: Address;
  /** Longest time between two due-checks. */
  pollIntervalMs: number;
  /** How long after a vault boundary to wake up (lets the boundary block land first). */
  boundaryGraceMs: number;
  /** Safety cap on `run()` pages per job per tick (a 10k-plan stock at 150 plans/page is 67 pages). */
  maxPagesPerJob: number;
  /** `limit` passed to `EpochKeeper.run`; 0 = the vault's `maxPlansPerTx`. */
  pageLimit: bigint;
  txTimeoutMs: number;
  /** How often to look for plans no job covers (see `Scheduler.checkUncovered`); 0 = never. */
  uncoveredCheckMs: number;
  /** Simulate only; never send. */
  dryRun: boolean;
  /** One tick, then exit (cron-friendly). */
  once: boolean;
};

/**
 * Load `.env.local` then `.env` from the package dir (values already in the environment win, like
 * `node --env-file`), then parse. CLI flags: `--once`, `--dry-run`.
 */
export function loadConfig(argv: string[] = process.argv.slice(2)): Config {
  for (const f of [".env.local", ".env"]) {
    const p = join(PKG_ROOT, f);
    if (existsSync(p)) process.loadEnvFile(p);
  }
  const env = process.env;
  const num = (k: string, d: number) => {
    const v = env[k];
    if (v === undefined || v === "") return d;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) throw new Error(`${k} must be a non-negative number, got "${v}"`);
    return n;
  };
  const bool = (k: string) => ["1", "true", "yes"].includes((env[k] ?? "").toLowerCase());

  const rpcUrl = env.RPC_URL;
  if (!rpcUrl) throw new Error("RPC_URL is required (e.g. http://127.0.0.1:8545 — `pnpm fork` writes apps/scheduler/.env.local)");

  const pk = env.PRIVATE_KEY;
  if (pk !== undefined && pk !== "" && !/^0x[0-9a-fA-F]{64}$/.test(pk)) throw new Error("PRIVATE_KEY must be a 0x-prefixed 32-byte hex key");
  const keeper = env.KEEPER_ADDRESS;
  if (keeper && !/^0x[0-9a-fA-F]{40}$/.test(keeper)) throw new Error("KEEPER_ADDRESS must be a 0x-prefixed address");

  return {
    rpcUrl,
    privateKey: pk ? (pk as Hex) : undefined,
    keeper: keeper ? (keeper as Address) : undefined,
    pollIntervalMs: num("POLL_INTERVAL_SECONDS", 30) * 1000,
    boundaryGraceMs: num("BOUNDARY_GRACE_SECONDS", 3) * 1000,
    maxPagesPerJob: Math.max(1, Math.floor(num("MAX_PAGES_PER_JOB", 20))),
    pageLimit: BigInt(Math.floor(num("PAGE_LIMIT", 0))),
    txTimeoutMs: num("TX_TIMEOUT_SECONDS", 120) * 1000,
    uncoveredCheckMs: num("UNCOVERED_CHECK_SECONDS", 300) * 1000,
    dryRun: bool("DRY_RUN") || argv.includes("--dry-run"),
    once: bool("ONCE") || argv.includes("--once"),
  };
}
