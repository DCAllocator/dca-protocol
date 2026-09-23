"use client";

import { useEffect, useId, type ReactNode } from "react";
import { HashLink, Icon, Spinner } from "@/components/ui";
import type { TxStepState, useTxSequence } from "@/hooks/useTx";
import { friendly } from "@/lib/txErrors";

// `HashLink` lives in ui.tsx now (toasts use it too); re-exported so earlier imports keep working.
export { HashLink };

/**
 * One row of the timeline. A `skipped` step is drawn as already done and never sent — the create flow
 * always lists "Approve USDG" so the user sees both halves, even when the allowance already covers the amount.
 */
export type FlowStep = {
  label: string;
  /** What the step does, shown while it waits its turn. */
  detail?: ReactNode;
  /** Replaces `detail` once the step is mined ("Approved", "Plan started"). */
  done?: string;
  /** Trailing detail on the label row, right-aligned ("≈ $99.75", "0.0123 NVDA"); shown in every phase, before the hash. */
  trailing?: ReactNode;
  /** Why the step is not needed this time; when set, the step is shown as done and no transaction is sent. */
  skipped?: string;
  /**
   * Why the step is held back for later (e.g. a delete that waits for a running buy); when set, the step is
   * drawn as still to do, with a dashed mark, and no transaction is sent in this run.
   */
  deferred?: string;
};

type Seq = Pick<ReturnType<typeof useTxSequence>, "steps" | "running" | "done" | "error" | "retry"> &
  Partial<Pick<ReturnType<typeof useTxSequence>, "waiting" | "keepWaiting">>;

/**
 * Modal that follows a transaction sequence step by step: each step goes waiting → in the wallet → on
 * the network → done, with its hash linked to the explorer once known. The dialog cannot be closed while
 * a step is in flight; after a failure it offers to pick up again from that step. A receipt that is slow to
 * arrive is not a failure: the step stays "on the network" and the only offer is to keep waiting on the
 * same hash — nothing is ever sent twice.
 */
export function TxFlowDialog({
  open,
  titles,
  subtitle,
  summary,
  flow,
  seq,
  onClose,
  doneActions,
}: {
  open: boolean;
  /** Heading per state of the sequence. */
  titles: { running: string; done: string; error: string };
  /** Line under the heading in the done state (the first buy, for a new plan). */
  subtitle?: ReactNode;
  /** Tile above the timeline recalling what is being sent. */
  summary?: ReactNode;
  flow: FlowStep[];
  seq: Seq;
  onClose: () => void;
  /** Buttons for the done state. */
  doneActions?: ReactNode;
}) {
  const id = useId();
  const closable = !seq.running;
  useEffect(() => {
    if (!open || !closable) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, closable, onClose]);
  if (!open) return null;

  // Sent steps map onto the non-skipped rows in order.
  let sent = 0;
  const rows = flow.map((f) => {
    if (f.skipped || f.deferred) return { flow: f, state: undefined };
    const state = seq.steps[sent++] as TxStepState | undefined;
    return { flow: f, state };
  });
  const total = seq.steps.length;
  const current = Math.min(total, seq.steps.filter((s) => s.phase === "done").length + 1);
  const waiting = !!seq.waiting;
  const status = seq.done ? "done" : seq.error ? "error" : waiting ? "waiting" : "running";

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && closable && onClose()}>
      <div role="dialog" aria-modal aria-labelledby={id} className="card anim-dialog-in w-full max-w-md rounded-b-none sm:rounded-b-xl">
        <header className="flex items-start justify-between gap-3 px-5 pt-5">
          {status === "done" ? (
            <div className="flex items-center gap-3">
              <span className="anim-pop inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-lime text-lime-ink">
                <Icon name="check" size={20} />
              </span>
              <div>
                <h2 id={id} className="text-[16px] font-medium text-ink">
                  {titles.done}
                </h2>
                {subtitle && <div className="text-[12.5px] text-ink-3">{subtitle}</div>}
              </div>
            </div>
          ) : (
            <div>
              <h2 id={id} className="text-[16px] font-medium text-ink">
                {status === "error" ? titles.error : titles.running}
              </h2>
              <div className="mt-0.5 text-[12.5px] text-ink-3">
                {status === "error"
                  ? "Nothing else was sent. You can pick up where it stopped."
                  : status === "waiting"
                    ? `Still waiting for the network · step ${current} of ${total}`
                    : `Confirm each step in your wallet · step ${current} of ${total}`}
              </div>
            </div>
          )}
          {closable && (
            <button type="button" onClick={onClose} aria-label="Close" className="btn-ghost -mt-1 -mr-2 h-8 w-8 shrink-0 px-0 text-ink-3">
              <Icon name="x" />
            </button>
          )}
        </header>

        <div className="card-pad grid gap-4">
          {summary}

          <ol className="grid">
            {rows.map(({ flow: f, state }, i) => {
              const phase = f.deferred ? "deferred" : f.skipped ? "skipped" : (state?.phase ?? "todo");
              const last = i === rows.length - 1;
              const filled = phase === "done" || phase === "skipped";
              return (
                <li key={f.label} className={`relative flex gap-3.5 ${last ? "" : "pb-5"}`}>
                  {!last && (
                    <span aria-hidden className="absolute top-9 bottom-1 left-4 w-px bg-line">
                      <span className={`absolute inset-0 origin-top bg-lime transition-transform duration-500 ease-out ${filled ? "scale-y-100" : "scale-y-0"}`} />
                    </span>
                  )}
                  <StepMark phase={phase} n={i + 1} />
                  <div className="min-w-0 flex-1 pt-1">
                    <div className="flex items-center justify-between gap-3">
                      <span className={`text-[14px] font-medium ${phase === "todo" || phase === "deferred" ? "text-ink-2" : "text-ink"}`}>{f.label}</span>
                      {(f.trailing !== undefined || state?.hash) && (
                        <span className="flex shrink-0 items-center gap-2">
                          {f.trailing !== undefined && <span className="num text-[12px] text-ink-3">{f.trailing}</span>}
                          {state?.hash && <HashLink hash={state.hash} />}
                        </span>
                      )}
                    </div>
                    <div className={`mt-0.5 text-[12.5px] leading-normal ${phase === "error" ? "text-bad" : phase === "signing" ? "text-ink-2" : "text-ink-3"}`}>
                      {phase === "skipped"
                        ? f.skipped
                        : phase === "deferred"
                          ? f.deferred
                        : phase === "signing"
                          ? "Confirm in your wallet…"
                          : phase === "mining"
                            ? waiting
                              ? "Sent, still waiting for the network — it has not failed. Check the hash on the explorer."
                              : "Sent — waiting for the network…"
                            : phase === "done"
                              ? (f.done ?? "Confirmed")
                              : phase === "error"
                                ? friendly(state?.error)
                                : f.detail}
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>

          {status === "error" && (
            <div className="grid grid-cols-2 gap-2">
              <button type="button" className="btn-secondary" onClick={onClose}>
                Close
              </button>
              <button type="button" className="btn-primary" onClick={() => seq.retry()}>
                Try again
              </button>
            </div>
          )}
          {status === "waiting" && (
            <div className="grid gap-2">
              {/* Re-arms the wait on the same hash; the sequence never resends on its own. */}
              <button type="button" className="btn-primary" onClick={() => (seq.keepWaiting ?? seq.retry)()}>
                Keep waiting
              </button>
              <p className="text-center text-[11.5px] text-ink-3">The transaction is sent and may still land. Nothing else will be sent.</p>
            </div>
          )}
          {status === "done" && doneActions}
          {status === "running" && (
            <p className="text-center text-[11.5px] text-ink-3">Keep this window open until every step is confirmed.</p>
          )}
        </div>
      </div>
    </div>
  );
}

type Phase = TxStepState["phase"] | "skipped" | "deferred";

/** 32px disc at the head of a row: number → spinner (with a halo while the wallet has it) → check, or a cross; a deferred step keeps its number on a dashed ring. */
function StepMark({ phase, n }: { phase: Phase; n: number }) {
  const cls: Record<Phase, string> = {
    todo: "border border-line-strong bg-surface-3 text-ink-3",
    signing: "anim-halo border border-lime bg-surface-3 text-lime",
    mining: "border border-lime bg-surface-3 text-lime",
    done: "bg-lime text-lime-ink",
    skipped: "bg-lime/15 text-lime",
    deferred: "border border-dashed border-line-strong bg-surface-3 text-ink-3",
    error: "border border-bad/40 bg-bad/15 text-bad",
  };
  return (
    <span className={`relative z-10 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[12.5px] font-semibold transition-colors ${cls[phase]}`}>
      {phase === "signing" || phase === "mining" ? (
        <Spinner />
      ) : phase === "done" ? (
        <span className="anim-pop inline-flex">
          <Icon name="check" size={16} />
        </span>
      ) : phase === "skipped" ? (
        <Icon name="check" size={16} />
      ) : phase === "error" ? (
        <Icon name="x" size={16} />
      ) : (
        n
      )}
    </span>
  );
}
