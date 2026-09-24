import { VAULT_KINDS, VAULT_META, type VaultKind } from "@/lib/config";

/*
 * Deep links into Create plan. `?stock=` (a ticker or address) is built by `createPlanHref` in
 * components/site/LandingLive.tsx and read by `useStockParam`; `?frequency=` is built and parsed here and read by
 * `useFrequencyParam` (components/app/create/useCreatePlan.ts). Pure, so the server-rendered landing can use it.
 */

/** The query parameter that picks the frequency Create plan opens on. */
export const FREQUENCY_PARAM = "frequency";

/** Create plan opened on `kind`, e.g. "/app/create?frequency=weekly" (the landing pages' vault rows and plan cards). */
export const frequencyHref = (kind: VaultKind) => `/app/create?${FREQUENCY_PARAM}=${kind}`;

/**
 * "Start a weekly plan" / "Start an hourly plan": what a `frequencyHref` link says — the visible text of /legacy's plan
 * cards, the accessible name of the landings' "Start" buttons (which keeps the visible word "Start" in it).
 */
export const startPlanLabel = (kind: VaultKind) => {
  const label = VAULT_META[kind].label.toLowerCase();
  return `Start ${/^[aeiou]|^hour/.test(label) ? "an" : "a"} ${label} plan`;
};

/**
 * A `?frequency=` value as a frequency this app shows, else undefined: an unknown value, and the dev-only `test` kind
 * whenever its vault is not shown (`VAULT_KINDS` lists it only then), are ignored. Case and whitespace do not matter.
 */
export function parseFrequencyParam(value: string | null | undefined): VaultKind | undefined {
  const v = value?.trim().toLowerCase();
  return v ? VAULT_KINDS.find((k) => k === v) : undefined;
}
