"use client";

import { useCreatePlan } from "@/components/app/create/useCreatePlan";
import { CreateTabs } from "@/components/app/create/CreateTabs";
import {
  BoostBlock,
  CreateCta,
  CreateDetails,
  CreateFlowDialog,
  DcaPerksBanner,
  EstimateLine,
  Footnote,
  FundPlanBox,
  NotConfigured,
  PlanSummary,
  SpendEverySentence,
  StockRow,
} from "@/components/app/create/blocks";

/**
 * Variant B of the create card, for side-by-side comparison with /app/create (a comparison URL only: no
 * traffic split, no analytics). Reads as a sentence: "Spend [amount] USDG every [day ▾]" → "On [stock ▾]" (a
 * row that opens the stock picker dialog) → "Fund plan" (the amount, how many times it runs, and a warning when it
 * is less than one buy) → boost → a one-line summary (and what the buys get at today's price) → button, with the $DCA
 * holder-perk banner under the card. Same `useCreatePlan` model, so the `createPlan` calldata, the frozen order and
 * the dialog's steps are identical to /app/create for identical inputs.
 */
export default function CreatePlanSentence() {
  const m = useCreatePlan({ defaultKind: "daily" });
  if (!m.configured) return <NotConfigured />;
  return (
    <div className="mx-auto max-w-[480px] pt-1 sm:pt-6">
      <CreateTabs />
      <div className="rounded-2xl border border-line bg-surface-2 p-4 sm:p-5">
        <SpendEverySentence m={m} />
        <StockRow m={m} className="mt-3" />
        <FundPlanBox m={m} className="mt-3" />
        <BoostBlock m={m} />
        <PlanSummary m={m} />
        <EstimateLine m={m} className="mt-1 text-center" />
        <CreateCta m={m} />
        <CreateDetails m={m} />
      </div>
      <DcaPerksBanner m={m} />
      <CreateFlowDialog m={m} />
      <Footnote m={m} />
    </div>
  );
}
