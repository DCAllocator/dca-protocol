"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { findStock, useDirectory, useKindsBuying, useStocks } from "@/hooks/useProtocol";
import { PRODUCTION_VAULT_KINDS, type ProductionVaultKind } from "@/lib/config";
import { DEFAULT_DRAFT, INTERVAL_WORD } from "./config";

/*
 * The visitor's plan sentence ("Buy $50 of NVDA every week."), written in the Three steps builder and read by the
 * stock tiles, the closing band and the sticky bar, so a plan built once follows the visitor down the page and into
 * Create plan. It lives for the browser session (sessionStorage), never on a server, and starts from DEFAULT_DRAFT.
 */

export type PlanDraft = {
  symbol: string;
  /** USD per buy. */
  amount: number;
  kind: ProductionVaultKind;
  /** The visitor changed something: only then do other sections personalise ("Start this plan", "Your plan: …"). */
  touched: boolean;
};

export type PlanDraftApi = {
  draft: PlanDraft;
  /** Merges `patch` into the draft and marks it touched (also mirrored to sessionStorage). */
  update: (patch: Partial<Omit<PlanDraft, "touched">>) => void;
  /** Create plan for this draft: `/app/create?stock=NVDA&frequency=weekly&amount=50`, without `stock=` when no vault buys it at that frequency. */
  href: string;
  /** "$50 of NVDA every week" (no leading verb, no full stop). */
  sentence: string;
};

const STORAGE_KEY = "dca.v3.draft";

const isKind = (v: unknown): v is ProductionVaultKind => typeof v === "string" && (PRODUCTION_VAULT_KINDS as readonly string[]).includes(v);

/** A stored draft, if it still parses into something sane; anything else is ignored. */
function readStored(): Omit<PlanDraft, "touched"> | undefined {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return undefined;
    const v = JSON.parse(raw) as Record<string, unknown>;
    const symbol = typeof v.symbol === "string" ? v.symbol.trim().toUpperCase() : "";
    const amount = typeof v.amount === "number" ? v.amount : NaN;
    if (!/^[A-Z0-9.]{1,12}$/.test(symbol) || !Number.isFinite(amount) || amount <= 0 || !isKind(v.kind)) return undefined;
    return { symbol, amount, kind: v.kind };
  } catch {
    return undefined;
  }
}

function writeStored(d: Omit<PlanDraft, "touched">) {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ symbol: d.symbol, amount: d.amount, kind: d.kind }));
  } catch {
    /* private mode / blocked storage: the draft still lives for this page view */
  }
}

/**
 * Create plan for a pick: `/app/create?stock=NVDA&frequency=weekly&amount=50`, without `stock=` when `withStock` is
 * false. The one link builder for the page (the draft's `href`, the plan builder's CTA). `amount` is ignored by Create
 * until AMOUNT_PARAM_SUPPORTED flips (config.ts); it is kept so the links are forward-compatible.
 */
export const planHref = (d: { symbol: string; amount: number; kind: ProductionVaultKind }, withStock: boolean) =>
  `/app/create?${withStock ? `stock=${encodeURIComponent(d.symbol)}&` : ""}frequency=${d.kind}&amount=${d.amount}`;

const sentenceOf = (d: Omit<PlanDraft, "touched">) => `$${d.amount.toLocaleString("en-US")} of ${d.symbol} every ${INTERVAL_WORD[d.kind]}`;

const DEFAULT: PlanDraft = { ...DEFAULT_DRAFT, touched: false };

/** What `usePlanDraft` answers outside a provider: the default draft, a Create link without the stock, and a no-op. */
const FALLBACK: PlanDraftApi = { draft: DEFAULT, update: () => {}, href: planHref(DEFAULT, false), sentence: sentenceOf(DEFAULT) };

const PlanDraftContext = createContext<PlanDraftApi | null>(null);

export function PlanDraftProvider({ children }: { children: ReactNode }) {
  const [draft, setDraft] = useState<PlanDraft>(DEFAULT);

  // Restored once after mount (never during render), so the server's HTML and the first client render agree.
  useEffect(() => {
    const stored = readStored();
    if (stored) setDraft({ ...stored, touched: true });
  }, []);

  const update = useCallback((patch: Partial<Omit<PlanDraft, "touched">>) => setDraft((d) => ({ ...d, ...patch, touched: true })), []);

  // Mirror every touched draft (the restored one included: a harmless rewrite of the same value).
  useEffect(() => {
    if (draft.touched) writeStored(draft);
  }, [draft]);

  // `stock=` only when some production vault buys this stock at this frequency; otherwise Create would open on a notice.
  const { dir, configured } = useDirectory();
  const { stocks } = useStocks(dir?.registry);
  const { kindsBuying } = useKindsBuying();
  const stock = configured ? findStock(stocks, draft.symbol) : undefined;
  const withStock = !!stock && !!kindsBuying(stock.address)?.includes(draft.kind);

  const value = useMemo<PlanDraftApi>(() => ({ draft, update, href: planHref(draft, withStock), sentence: sentenceOf(draft) }), [draft, update, withStock]);
  return <PlanDraftContext.Provider value={value}>{children}</PlanDraftContext.Provider>;
}

/** The visitor's plan draft; outside a `PlanDraftProvider` the defaults and a no-op `update`. */
export function usePlanDraft(): PlanDraftApi {
  return useContext(PlanDraftContext) ?? FALLBACK;
}
