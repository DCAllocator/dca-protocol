"use client";

import { useCreatePlan } from "@/components/app/create/useCreatePlan";
import { CreateTabs } from "@/components/app/create/CreateTabs";
import {
  Arrow,
  BoostBlock,
  CreateCta,
  CreateDetails,
  CreateFlowDialog,
  DcaPerksBanner,
  EstimateLine,
  EveryPerBuyGrid,
  Footnote,
  FundWithBox,
  MonthlyLine,
  NotConfigured,
  StockRow,
} from "@/components/app/create/blocks";

/**
 * Create page in the shape of a swap card (Jupiter's DCA form), whose labels read top to bottom as one sentence:
 * "Fund plan with [X USDG | ETH]" → "To buy [stock]" (an arrow between them) → "Every [day]" beside "For [N USDG per
 * buy]". Under that, what the buys get at today's price and the monthly pace, then the boost switch and one big
 * button, with the $DCA holder-perk banner under the card. "To buy" is /app/create/2's stock row (the picker dialog,
 * plus "Add to MetaMask" once a wallet is connected). The form logic lives in `useCreatePlan` (including the
 * landing pages' `?stock=` / `?frequency=` links); /app/create/2 renders the same model in sentence order, and the
 * numbered-steps layout lives on at /app/create/legacy. All send the same transaction.
 */
export default function CreatePlanCard() {
  const m = useCreatePlan({ defaultKind: "daily" });
  if (!m.configured) return <NotConfigured />;
  return (
    <div className="mx-auto max-w-[480px] pt-1 sm:pt-6">
      <CreateTabs />
      <div className="rounded-2xl border border-line bg-surface-2 p-4 sm:p-5">
        <FundWithBox m={m} />
        <Arrow />
        <StockRow m={m} label="To buy" addToWallet />
        <EveryPerBuyGrid m={m} />
        {/* Both lines are optional; with neither, the empty wrapper collapses and takes no space. */}
        <div className="mt-2 grid gap-1 empty:hidden">
          <EstimateLine m={m} />
          <MonthlyLine m={m} />
        </div>
        <BoostBlock m={m} />
        <CreateCta m={m} />
        <CreateDetails m={m} />
      </div>
      <DcaPerksBanner m={m} title="Hold $DCA for automatic distributions" />
      <CreateFlowDialog m={m} />
      <Footnote m={m} />
    </div>
  );
}
