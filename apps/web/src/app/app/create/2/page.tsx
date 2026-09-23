"use client";

import { useCreatePlan } from "@/components/app/create/useCreatePlan";
import { CreateTabs } from "@/components/app/create/CreateTabs";
import {
  BoostBlock,
  BuyEverySentence,
  CreateCta,
  CreateDetails,
  CreateFlowDialog,
  Footnote,
  FundWithBox,
  MonthlyLine,
  NotConfigured,
  StockBox,
} from "@/components/app/create/blocks";

/**
 * Variant B of the create card, for side-by-side comparison with /app/create (a comparison URL only: no
 * traffic split, no analytics). Reads as a sentence: "Buy [amount] USDG every [day ▾]" → "Of" (the stock) →
 * "Fund plan with" (entered last, so the "covers N buys" hint sits here) → boost → button. Same
 * `useCreatePlan` model, so the `createPlan` calldata, the frozen order and the dialog's steps are
 * identical to /app/create for identical inputs.
 */
export default function CreatePlanSentence() {
  const m = useCreatePlan({ defaultKind: "daily" });
  if (!m.configured) return <NotConfigured />;
  return (
    <div className="mx-auto max-w-[480px] pt-1 sm:pt-6">
      <CreateTabs />
      <div className="rounded-2xl border border-line bg-surface-2 p-4 sm:p-5">
        <BuyEverySentence m={m} />
        <StockBox m={m} label="Of" className="mt-3" />
        <FundWithBox m={m} label="Fund plan with" coverage className="mt-3" />
        <MonthlyLine m={m} />
        <BoostBlock m={m} />
        <CreateCta m={m} />
        <CreateDetails m={m} />
      </div>
      <CreateFlowDialog m={m} />
      <Footnote m={m} />
    </div>
  );
}
