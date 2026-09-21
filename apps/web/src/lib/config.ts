import type { Address } from "viem";
import { activeChain } from "./chain";

const addr = (v: string | undefined, name: string): Address => {
  if (!v || !/^0x[0-9a-fA-F]{40}$/.test(v)) {
    if (typeof window !== "undefined") console.warn(`[dca] ${name} is not configured`);
    return "0x0000000000000000000000000000000000000000";
  }
  return v as Address;
};

export const ADDRESSES = {
  directory: addr(process.env.NEXT_PUBLIC_DIRECTORY, "NEXT_PUBLIC_DIRECTORY"),
  claimHelper: addr(process.env.NEXT_PUBLIC_CLAIM_HELPER, "NEXT_PUBLIC_CLAIM_HELPER"),
  zap: addr(process.env.NEXT_PUBLIC_ZAP, "NEXT_PUBLIC_ZAP"),
};

export const ZERO: Address = "0x0000000000000000000000000000000000000000";
export const MAX_UINT256 = 2n ** 256n - 1n;
export const isZero = (a?: Address) => !a || a === ZERO;
export const LOG_LOOKBACK = BigInt(process.env.NEXT_PUBLIC_LOG_LOOKBACK ?? "200000");
export const BPS = 10_000n;
export const USDG_DECIMALS = 6;
export const SECONDS_PER_YEAR = 365 * 86_400;

/**
 * Product copy for the boost feature (idle USDG lent on Morpho Blue while a plan waits to buy).
 * `off` is the label of the action that switches it back off — kept in one place so it is a one-line rename.
 */
export const BOOST = {
  name: "Boost",
  on: "Boost",
  off: "Unboost",
  chip: "Boosted",
  title: "Earn while you wait",
  tip: "Idle USDG in this plan is lent on Morpho Blue and earns the market's supply rate until each buy. It is pulled back automatically at every buy and whenever you withdraw. Lending carries its own risks: the market can run short of liquidity or take on bad debt.",
} as const;

/** The three production frequencies, in display order (this is what the marketing site shows). */
export const PRODUCTION_VAULT_KINDS = ["daily", "weekly", "monthly"] as const;
export type ProductionVaultKind = (typeof PRODUCTION_VAULT_KINDS)[number];
/** `test` is the local-only short-epoch TestVault (contracts/test/mocks/TestVault.sol); see TEST_VAULT. */
export type VaultKind = ProductionVaultKind | "test";

const flagOn = (v: string | undefined) => ["1", "true", "yes"].includes((v ?? "").toLowerCase());

/**
 * Dev-only test vault (minutes-long epochs, advanced by apps/scheduler). Shown only when the app targets
 * anvil (31337) AND the dev server was started with NEXT_PUBLIC_SHOW_TEST_VAULT=1 (`pnpm dev:test-vault`).
 * Its address comes from NEXT_PUBLIC_TEST_VAULT, which `pnpm fork` writes from contracts/deployments/31337.json.
 * It is not in VaultDirectory and never shown on a real chain, whatever the flags say.
 */
export const TEST_VAULT: Address | undefined = (() => {
  if (activeChain.id !== 31337 || !flagOn(process.env.NEXT_PUBLIC_SHOW_TEST_VAULT)) return undefined;
  const v = process.env.NEXT_PUBLIC_TEST_VAULT;
  if (!v || !/^0x[0-9a-fA-F]{40}$/.test(v)) {
    if (typeof window !== "undefined") console.warn("[dca] NEXT_PUBLIC_SHOW_TEST_VAULT is on but NEXT_PUBLIC_TEST_VAULT is not set — run `pnpm fork` (it writes .env.local) and restart the dev server");
    return undefined;
  }
  return v as Address;
})();

/** Vault kinds the app shows, in display order. */
export const VAULT_KINDS: readonly VaultKind[] = TEST_VAULT ? [...PRODUCTION_VAULT_KINDS, "test"] : PRODUCTION_VAULT_KINDS;

/**
 * User-facing copy per frequency. "Vault" is the contract-side name; in the product a user picks a
 * *frequency* for their *plan*. `per` is the noun used after an amount ("$50 per day"). The test vault's
 * cadence and buys-per-month depend on its on-chain `epochLength` — use `cadenceOf` / `buysPerMonthOf`.
 */
export const VAULT_META: Record<
  VaultKind,
  { label: string; per: string; cadence: string; blurb: string; buysPerMonth: number; defaultFeeBps: number }
> = {
  daily: { label: "Daily", per: "day", cadence: "Every day at 00:00 UTC", blurb: "Smoothest entry. Buys every day.", buysPerMonth: 30, defaultFeeBps: 75 },
  weekly: { label: "Weekly", per: "week", cadence: "Every Monday at 00:00 UTC", blurb: "The classic. One buy a week.", buysPerMonth: 4.35, defaultFeeBps: 50 },
  monthly: { label: "Monthly", per: "month", cadence: "Every 30 days", blurb: "Set it and forget it.", buysPerMonth: 1, defaultFeeBps: 25 },
  test: { label: "Test", per: "epoch", cadence: "Every few minutes (local)", blurb: "Dev only. Minutes-long epochs, run by the scheduler.", buysPerMonth: 21_600, defaultFeeBps: 75 },
};

/** Cadence line for a vault; the test vault's follows its on-chain `epochLength` (seconds). */
export function cadenceOf(kind: VaultKind, epochLength?: number): string {
  if (kind !== "test" || !epochLength) return VAULT_META[kind].cadence;
  return `Every ${fmtEpochLength(epochLength)} (local)`;
}

/** Buys per 30 days; the test vault's follows its on-chain `epochLength` (seconds). */
export function buysPerMonthOf(kind: VaultKind, epochLength?: number): number {
  if (kind !== "test" || !epochLength) return VAULT_META[kind].buysPerMonth;
  return (30 * 86_400) / epochLength;
}

function fmtEpochLength(seconds: number): string {
  if (seconds % 3600 === 0) return seconds === 3600 ? "hour" : `${seconds / 3600} hours`;
  if (seconds % 60 === 0) return seconds === 60 ? "minute" : `${seconds / 60} minutes`;
  return `${seconds} seconds`;
}

/**
 * $DCA balances that unlock the holder perks, as the contracts deploy them (raw 18-decimal units; mirrors
 * `contracts/config/fees.json`). The vaults are the source of truth — `usePerkThresholds` reads them live and only
 * falls back to these before the chain responds (or when the app is not configured).
 */
export const DCA_PERK_DEFAULTS = {
  autoDistribute: 100_000n * 10n ** 18n,
  feeHalve: 100_000n * 10n ** 18n,
} as const;

/** Marketing name for the docs link shown next to the $DCA quip. */
export const DOCS_PATH = "/app/docs";
