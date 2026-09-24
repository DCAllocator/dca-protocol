"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { HashLink, Icon, Spinner } from "@/components/ui";
import { WALLET_SYNC_COPY, type TxStepState, type useTxSequence } from "@/hooks/useTx";
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
  Partial<Pick<ReturnType<typeof useTxSequence>, "waiting" | "keepWaiting" | "syncing" | "cancel">>;

/**
 * What a `hero` header is drawn from, in every state of the sequence. The hero renders the dialog's heading
 * itself, as an h2 with `titleId` (visually hidden is fine once it carries its own wordmark).
 */
export type TxHero = {
  status: "running" | "waiting" | "error" | "done";
  titleId: string;
  titles: { running: string; done: string; error: string };
  /** The line under the heading: the wallet / network prompt, the error note, or `subtitle` once done. */
  line: ReactNode;
};

/** How long after the done state lands (and `announceReady`) its announcement is read: past the Boost hero's discharge. */
const ANNOUNCE_MS = 700;

/**
 * Modal that follows a transaction sequence step by step: each step goes waiting → in the wallet → on
 * the network → done, with its hash linked to the explorer once known. The dialog cannot be closed while
 * a step is in flight; after a failure it offers to pick up again from that step. A receipt that is slow to
 * arrive is not a failure: the step stays "on the network" and the offer is to keep waiting on the same hash
 * (or, with `closableWhileWaiting`, to close and let it land) — nothing is ever sent twice.
 *
 * While the next step is held back for the wallet to catch up with the last one (`seq.syncing`), nothing has been
 * sent for it: the dialog can be closed then, which cancels the run. A step the wallet refused over its nonce that
 * may have gone through anyway (`maybeSent`) is not offered as "Try again": the user checks the wallet first.
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
  hero,
  doneMark,
  closableWhileWaiting = false,
  announceReady = true,
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
  /**
   * Replaces the whole header, in every state, with a centred hero (the Boost flow's `BoostCelebration`), so the
   * card keeps its height when the done state lands and the celebration can grow out of the pending state. The
   * hero draws the heading (see `TxHero`); the close button floats top-right over it.
   */
  hero?: (hero: TxHero) => ReactNode;
  /** Replaces only the 40px check disc of the done header (Unboost's `<BoostPowerDown />`). */
  doneMark?: ReactNode;
  /**
   * Lets the user close while a sent step is still waiting for the network (nothing more will be sent; the caller
   * reconciles whenever it lands). Single-plan actions opt in, so a slow or dropped transaction cannot hold the page;
   * multi-step flows whose later steps depend on the pending one keep the dialog open.
   */
  closableWhileWaiting?: boolean;
  /**
   * Whether the done line is final. A caller that swaps in mined figures once the receipt is read passes `false`
   * until then, so the done state is announced once, with those figures, instead of twice.
   */
  announceReady?: boolean;
}) {
  const id = useId();
  // Focus moves into the dialog when it opens and back to whatever had it when it closes (if that is still there).
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    return () => {
      if (prev?.isConnected && !prev.matches(":disabled")) prev.focus();
      else prev?.closest("tr")?.querySelector<HTMLElement>("button:not(:disabled)")?.focus();
    };
  }, [open]);
  const syncing = !!seq.syncing;
  const closable = !seq.running || syncing || (closableWhileWaiting && !!seq.waiting);
  // Closing while held back for the wallet ends the run before its prompt (the caller's reset would too).
  const cancel = seq.cancel;
  const close = syncing && cancel ? () => (cancel(), onClose()) : onClose;
  useEffect(() => {
    if (!open || !closable) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, closable, close]);
  // The done state is announced from a status region that has been in the dialog since it opened (one inserted
  // already filled is often skipped), a beat after it lands.
  const [announce, setAnnounce] = useState(false);
  useEffect(() => {
    if (!open || !seq.done || !announceReady) return;
    const t = window.setTimeout(() => setAnnounce(true), ANNOUNCE_MS);
    return () => {
      window.clearTimeout(t);
      setAnnounce(false);
    };
  }, [open, seq.done, announceReady]);
  if (!open) return null;

  const total = seq.steps.length;
  const current = Math.min(total, seq.steps.filter((s) => s.phase === "done").length + 1);
  // Once the wallet has signed, the current step is on the network: say so instead of asking for a confirmation.
  const onNetwork = seq.steps[current - 1]?.phase === "mining";
  const of = total > 1 ? ` · step ${current} of ${total}` : "";
  const waiting = !!seq.waiting;
  const status = seq.done ? "done" : seq.error ? "error" : waiting ? "waiting" : "running";
  const failed = seq.steps.find((s) => s.phase === "error");
  // A send the wallet refused over its nonce, where the account's count moved since: it may have gone through.
  const maybeSent = status === "error" && !!failed?.maybeSent;
  const note =
    status === "error"
      ? maybeSent
        ? "Nothing else was sent. Check your wallet's activity before starting again."
        : failed?.conflict
          ? "You can try again from this step."
          : "Nothing else was sent. You can pick up where it stopped."
      : status === "waiting"
        ? `Still waiting for the network${of}`
        : onNetwork
          ? `Sent — waiting for the network${of}`
          : syncing
            ? `Waiting for your wallet${of}`
            : `${total > 1 ? "Confirm each step in your wallet" : "Confirm in your wallet"}${of}`;
  // What the status region reads: a failure or a stalled wait at once (the dialog keeps focus, so nothing else would
  // say it), the done state a beat after it lands. A live subtitle (the create flow's countdown) stays out of it, or
  // it would be re-read every tick.
  const live =
    status === "error"
      ? `${titles.error}. ${friendly(failed?.error)}`
      : status === "waiting"
        ? `${note}. The transaction is sent and may still land.`
        : syncing
          ? `${WALLET_SYNC_COPY} Nothing has been sent for this step yet.`
          : announce && seq.done
            ? typeof subtitle === "string"
              ? `${titles.done}. ${subtitle}`
              : titles.done
            : "";

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && closable && close()}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal
        aria-labelledby={id}
        tabIndex={-1}
        className="card anim-dialog-in w-full max-w-md rounded-b-none outline-none sm:rounded-b-xl"
      >
        <header className={hero ? "relative px-5 pt-5" : "flex items-start justify-between gap-3 px-5 pt-5"}>
          {hero ? (
            hero({ status, titleId: id, titles, line: status === "done" ? subtitle : note })
          ) : status === "done" ? (
            <div className="flex items-center gap-3">
              {doneMark ?? (
                <span className="anim-pop inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-lime text-lime-ink">
                  <Icon name="check" size={20} />
                </span>
              )}
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
              <div className="mt-0.5 text-[12.5px] text-ink-3">{note}</div>
            </div>
          )}
          {closable && (
            <button
              type="button"
              onClick={close}
              aria-label="Close"
              className={`btn-ghost h-8 w-8 shrink-0 px-0 text-ink-3 ${hero ? "absolute top-4 right-3" : "-mt-1 -mr-2"}`}
            >
              <Icon name="x" />
            </button>
          )}
        </header>
        {/* In the DOM from the first frame: a region inserted already filled is often not read. */}
        <p role="status" className="sr-only">
          {live}
        </p>

        <div className="card-pad grid gap-4">
          {summary}

          <FlowTimeline flow={flow} steps={seq.steps} waiting={waiting} />

          {status === "error" &&
            (maybeSent ? (
              // It may have landed: no second send from here, the wallet's activity says whether to start again.
              <button type="button" className="btn-secondary w-full" onClick={onClose}>
                Close
              </button>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                <button type="button" className="btn-secondary" onClick={onClose}>
                  Close
                </button>
                <button type="button" className="btn-primary" onClick={() => seq.retry()}>
                  Try again
                </button>
              </div>
            ))}
          {status === "waiting" && (
            <div className="grid gap-2">
              {/* Re-arms the wait on the same hash; the sequence never resends on its own. */}
              <button type="button" className="btn-primary" onClick={() => (seq.keepWaiting ?? seq.retry)()}>
                Keep waiting
              </button>
              {closableWhileWaiting && (
                <button type="button" className="btn-ghost w-full" onClick={onClose}>
                  Close — it may still land
                </button>
              )}
              <p className="text-center text-[11.5px] text-ink-3">The transaction is sent and may still land. Nothing else will be sent.</p>
            </div>
          )}
          {status === "done" && doneActions}
          {status === "running" &&
            (syncing ? (
              <div className="grid gap-2">
                <button type="button" className="btn-ghost w-full" onClick={close}>
                  Cancel
                </button>
                <p className="text-center text-[11.5px] text-ink-3">Nothing has been sent for this step yet. Your wallet asks you to confirm once it has caught up.</p>
              </div>
            ) : (
              <p className="text-center text-[11.5px] text-ink-3">Keep this window open until {total > 1 ? "every step is" : "it is"} confirmed.</p>
            ))}
        </div>
      </div>
    </div>
  );
}

/**
 * The timeline itself: one row per `FlowStep`, with the sent steps (`steps`, in order) mapped onto the rows that are
 * neither skipped nor deferred. Without `steps` every such row is still to do — how a form previews, in the same
 * rows, what it is about to send.
 */
export function FlowTimeline({ flow, steps = [], waiting = false }: { flow: FlowStep[]; steps?: readonly TxStepState[]; waiting?: boolean }) {
  // Sent steps map onto the non-skipped rows in order.
  let sent = 0;
  const rows = flow.map((f) => {
    if (f.skipped || f.deferred) return { flow: f, state: undefined };
    const state = steps[sent++] as TxStepState | undefined;
    return { flow: f, state };
  });
  return (
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
                    ? (state?.note ?? "Confirm in your wallet…")
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
