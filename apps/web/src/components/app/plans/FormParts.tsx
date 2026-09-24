"use client";

import type { ReactNode } from "react";
import { Icon } from "@/components/ui";

/**
 * Pieces of the deposit and withdraw forms on My plans, drawn in the same register as the flow dialog that follows
 * them (`PlanFlowSummary`'s tile) and the create flow's `UnderfundedWarning`.
 */

/** One line of a form's summary: label, value, and how it reads (`words`: not set in the mono face). */
export type SummaryRow = { k: string; v: ReactNode; tone?: "strong" | "warn"; words?: boolean };

/** What the form is about to do, before anything is signed: "You deposit", "Plan after", "Covers"… */
export function FormSummary({ rows }: { rows: SummaryRow[] }) {
  return (
    <dl className="grid gap-1 rounded-xl border border-line bg-surface-3 px-3.5 py-2.5 text-[12.5px]">
      {rows.map(({ k, v, tone, words }) => (
        <div key={k} className="flex items-baseline justify-between gap-3">
          <dt className="text-ink-3">{k}</dt>
          <dd className={`text-right ${tone === "warn" ? "text-warn" : tone === "strong" ? "font-medium text-ink" : "text-ink-2"} ${words ? "" : "num"}`}>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * A plan balance under one buy (or emptied), said the way the create flow says it: `warn` in the amber register of
 * `UnderfundedWarning`, `info` on the quiet surface for an outcome the user chose on purpose.
 */
export function FundsNote({ tone = "warn", children }: { tone?: "warn" | "info"; children: ReactNode }) {
  return (
    <div
      role="status"
      className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-[12px] leading-snug ${
        tone === "warn" ? "border-amber-line bg-amber-bg text-warn" : "border-line-strong bg-surface-3 text-ink-2"
      }`}
    >
      <Icon name="info" size={14} className="mt-px shrink-0" />
      <span>{children}</span>
    </div>
  );
}
