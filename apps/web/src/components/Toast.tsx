"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { Hash } from "viem";
import { HashLink, Icon } from "@/components/ui";

export type ToastKind = "ok" | "info" | "warn" | "error";

export type ToastInput = {
  kind?: ToastKind;
  /** The one line everyone reads. */
  title: string;
  /** Optional second line (a revert reason, a hint). */
  detail?: ReactNode;
  /** Transaction hash, shown short and linked to the explorer when the chain has one. */
  hash?: Hash;
  /** Override the auto-dismiss delay in ms; `0` keeps the toast until dismissed. */
  duration?: number;
};

type ToastItem = Required<Pick<ToastInput, "kind">> & ToastInput & { id: number };

type ToastApi = {
  /** Shows a toast and returns its id (for an early `dismiss`). */
  toast: (t: ToastInput) => number;
  dismiss: (id: number) => void;
};

/** Most toasts on screen at once; the oldest goes when a fifth arrives. */
const MAX_TOASTS = 4;
/** Good news is glanced at; warnings and errors get a little longer. */
const DURATION_MS: Record<ToastKind, number> = { ok: 5_000, info: 5_000, warn: 8_000, error: 8_000 };

const noop: ToastApi = {
  toast: (t) => {
    if (typeof console !== "undefined") console.warn("useToast() called outside <ToastProvider>:", t.title);
    return -1;
  },
  dismiss: () => {},
};

const ToastContext = createContext<ToastApi>(noop);

/**
 * Feedback for something that happened away from where the user is looking: a row's Boost landing while a
 * modal is open, a wallet rejection, a slow receipt. Toasts stack bottom-right in a portal on `document.body`,
 * above the modal overlay (z-50) and menus (z-60), and are announced politely to screen readers. Read them
 * anywhere with `useToast()`; mount the provider once, inside `Providers`.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const [mounted, setMounted] = useState(false);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  // Portals need `document`; render the host only after hydration.
  useEffect(() => {
    setMounted(true);
    const t = timers.current;
    return () => {
      t.forEach(clearTimeout);
      t.clear();
    };
  }, []);

  const dismiss = useCallback((id: number) => {
    const t = timers.current.get(id);
    if (t) clearTimeout(t);
    timers.current.delete(id);
    setItems((xs) => xs.filter((x) => x.id !== id));
  }, []);

  const toast = useCallback(
    (input: ToastInput) => {
      const id = nextId.current++;
      const kind = input.kind ?? "info";
      const item: ToastItem = { ...input, kind, id };
      setItems((xs) => {
        const next = [...xs, item];
        // Drop the oldest beyond the cap, clearing their timers so they cannot fire on a gone toast.
        while (next.length > MAX_TOASTS) {
          const gone = next.shift()!;
          const t = timers.current.get(gone.id);
          if (t) clearTimeout(t);
          timers.current.delete(gone.id);
        }
        return next;
      });
      const ms = input.duration ?? DURATION_MS[kind];
      if (ms > 0) timers.current.set(id, setTimeout(() => dismiss(id), ms));
      return id;
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(() => ({ toast, dismiss }), [toast, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      {mounted &&
        createPortal(
          <div
            role="status"
            aria-live="polite"
            aria-atomic="false"
            className="pointer-events-none fixed right-4 bottom-4 z-[70] flex w-[min(360px,calc(100vw-32px))] flex-col items-stretch gap-2"
          >
            {items.map((t) => (
              <ToastCard key={t.id} item={t} onDismiss={() => dismiss(t.id)} />
            ))}
          </div>,
          document.body,
        )}
    </ToastContext.Provider>
  );
}

/** Same class map as `Notice` so both themes read the same, plus a surface so it sits over any page. */
const TONE: Record<ToastKind, string> = {
  info: "border-line-strong bg-surface-3 text-ink-2",
  warn: "border-warn/30 bg-surface-3 text-warn",
  error: "border-bad/30 bg-surface-3 text-bad",
  ok: "border-lime/30 bg-surface-3 text-lime",
};

function ToastCard({ item, onDismiss }: { item: ToastItem; onDismiss: () => void }) {
  return (
    <div className={`anim-toast-in pointer-events-auto flex items-start gap-3 rounded-lg border px-3 py-2.5 text-[12.5px] leading-relaxed shadow-pop ${TONE[item.kind]}`}>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-3">
          <span className="font-medium">{item.title}</span>
          {item.hash && <HashLink hash={item.hash} />}
        </div>
        {item.detail && <div className="mt-0.5 text-ink-3">{item.detail}</div>}
      </div>
      <button type="button" onClick={onDismiss} aria-label="Dismiss" className="btn-ghost -mt-1 -mr-1.5 h-7 w-7 shrink-0 px-0 text-ink-3">
        <Icon name="x" size={14} />
      </button>
    </div>
  );
}

/** `{ toast, dismiss }` from the nearest `ToastProvider`; a warning no-op when there is none. */
export function useToast(): ToastApi {
  return useContext(ToastContext);
}
