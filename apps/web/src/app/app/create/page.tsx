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
  EveryPerBuyGrid,
  Footnote,
  FundWithBox,
  MonthlyLine,
  NotConfigured,
  StockRow,
} from "@/components/app/create/blocks";

/**
 * Create page in the shape of a swap card (Jupiter's DCA form): one centred card, "Fund with" over "Buy"
 * with an arrow between them, then "Every" (the frequency) beside "Buy" (the per-buy amount), the boost
 * switch and one big button, with the $DCA holder-perk banner under the card. "Buy" is /app/create/2's stock
 * row (the picker dialog, plus "Add to MetaMask" once a wallet is connected). The form logic lives in
 * `useCreatePlan`; /app/create/2 renders the same model in sentence order, and the numbered-steps layout lives
 * on at /app/create/legacy. All send the same transaction.
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
        <StockRow m={m} label="Buy" addToWallet />
        <EveryPerBuyGrid m={m} />
        <MonthlyLine m={m} />
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
