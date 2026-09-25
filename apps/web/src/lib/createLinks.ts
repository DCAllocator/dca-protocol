import { formatUnits, parseUnits } from "viem";
import { USDG_DECIMALS, VAULT_KINDS, type VaultKind } from "@/lib/config";

/*
 * Deep links into Create plan: `?stock=` (a ticker or address), `?frequency=` and `?amount=` (USDG per buy), all built
 * by `createHref` and read back by `useStockParam`, `useFrequencyParam` and `useAmountParam`
 * (components/app/create/useCreatePlan.ts). Pure, so the server-rendered landing can use it.
 */

/** The query parameter that picks the stock Create plan opens on. */
export const STOCK_PARAM = "stock";
/** The query parameter that picks the frequency Create plan opens on. */
export const FREQUENCY_PARAM = "frequency";
/** The query parameter that sets the amount per buy (USDG) Create plan opens on. */
export const AMOUNT_PARAM = "amount";

/**
 * Create plan opened on a pick, e.g. "/app/create?stock=NVDA&frequency=weekly&amount=50"; each part only when given,
 * plain "/app/create" with none. The one builder for every deep link into the form.
 */
export function createHref({ stock, kind, amount }: { stock?: string; kind?: VaultKind; amount?: number }) {
  const q = new URLSearchParams();
  if (stock) q.set(STOCK_PARAM, stock);
  if (kind) q.set(FREQUENCY_PARAM, kind);
  if (amount !== undefined && Number.isFinite(amount) && amount > 0) q.set(AMOUNT_PARAM, String(amount));
  const s = q.toString();
  return s ? `/app/create?${s}` : "/app/create";
}

/**
 * A `?frequency=` value as a frequency this app shows, else undefined: an unknown value, and the dev-only `test` kind
 * whenever its vault is not shown (`VAULT_KINDS` lists it only then), are ignored. Case and whitespace do not matter.
 */
export function parseFrequencyParam(value: string | null | undefined): VaultKind | undefined {
  const v = value?.trim().toLowerCase();
  return v ? VAULT_KINDS.find((k) => k === v) : undefined;
}

/**
 * An `?amount=` value as the per-buy field's text ("50", "12.5"), else undefined: only a plain positive decimal with at
 * most USDG's six decimals counts ("$50", "1e3", "0" and "50.1234567" are ignored). Whether it meets the vault's
 * minimum is the form's to say, as for a typed amount.
 */
export function parseAmountParam(value: string | null | undefined): string | undefined {
  const v = value?.trim();
  if (!v || !/^\d{1,12}(\.\d{1,6})?$/.test(v)) return undefined;
  const wei = parseUnits(v, USDG_DECIMALS);
  return wei > 0n ? formatUnits(wei, USDG_DECIMALS) : undefined;
}
