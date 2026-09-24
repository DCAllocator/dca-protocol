"use client";

import { Children, useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ElementType, type ReactNode, type RefObject } from "react";
import { Countdown } from "@/components/ui";
import "./v3.css";

/*
 * Shared motion primitives for the landing. Everything here is CSS-driven (transforms and opacity only) and falls back to
 * the static end state under `prefers-reduced-motion`, or when JavaScript has not run: `.v3-reveal` only hides once
 * the page script has set <html data-v3-motion> (see `MotionBoot`), so server-rendered content is never invisible.
 * The hooks do nothing on the server and nothing under reduced motion unless they say otherwise.
 */

type Vars = CSSProperties & Record<`--${string}`, string | number>;

/** Sets <html data-v3-motion> once hydrated, which arms `.v3-reveal` and `.v3-rise` (content stays visible if JS never runs). */
export function MotionBoot() {
  useEffect(() => {
    document.documentElement.dataset.v3Motion = "1";
    return () => {
      delete document.documentElement.dataset.v3Motion;
    };
  }, []);
  return null;
}

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const on = () => setReduced(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return reduced;
}

/** False on the server and in the first client render, true after: gate anything that differs between the two. */
export function useMounted(): boolean {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted;
}

const subscribeVisibility = (cb: () => void) => {
  document.addEventListener("visibilitychange", cb);
  return () => document.removeEventListener("visibilitychange", cb);
};

/** Whether the tab is showing (`document.visibilityState`); true on the server. Loops stop in a background tab. */
export function useDocumentVisible(): boolean {
  return useSyncExternalStore(
    subscribeVisibility,
    () => document.visibilityState !== "hidden",
    () => true,
  );
}

/**
 * Whether `ref` is on screen. `once` latches true on first sight (entrance animations); without it the value tracks
 * visibility (pause loops off-screen).
 */
export function useInView<T extends Element>(ref: RefObject<T | null>, { once = false, rootMargin = "0px 0px -10% 0px", threshold = 0 } = {}): boolean {
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setInView(true);
      return;
    }
    const io = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting) {
          setInView(true);
          if (once) io.disconnect();
        } else if (!once) setInView(false);
      },
      { rootMargin, threshold },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [ref, once, rootMargin, threshold]);
  return inView;
}

/**
 * A step counter for rotating content: advances every `interval` ms while `active`, the tab is visible and motion is
 * allowed. Pausing (inactive, hidden tab) holds the current step; reduced motion or fewer than two items pins it to 0,
 * and a new `count` starts again from 0. Drive `<CycleWord index>` and anything that must stay in step with it.
 */
export function useCycleIndex(count: number, { interval = 1800, active = true }: { interval?: number; active?: boolean } = {}): number {
  const reduced = useReducedMotion();
  const visible = useDocumentVisible();
  const [step, setStep] = useState(0);
  const [forCount, setForCount] = useState(count);
  if (forCount !== count) {
    // Adjusting state while rendering (React's documented pattern): the stale step never reaches the screen.
    setForCount(count);
    setStep(0);
  }
  const running = active && visible && !reduced && count > 1;
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setStep((s) => (s + 1) % count), interval);
    return () => clearInterval(t);
  }, [running, interval, count]);
  if (reduced || count < 2) return 0;
  return step % count;
}

/**
 * Pointer tilt for a card: on pointermove sets `--rx` / `--ry` (deg, within ±`max`, from the pointer's offset to the
 * centre) on `ref.current`, back to 0deg on pointerleave. The CSS applies them (`.v3-pass`). Fine pointers with hover
 * only, and off under reduced motion.
 */
export function usePointerTilt<T extends HTMLElement>(ref: RefObject<T | null>, max = 4): void {
  const reduced = useReducedMotion();
  useEffect(() => {
    const el = ref.current;
    if (!el || reduced || !window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;
    const clamp = (v: number) => Math.max(-max, Math.min(max, v));
    let raf = 0;
    const move = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return;
      const x = (e.clientX - r.left) / r.width - 0.5;
      const y = (e.clientY - r.top) / r.height - 0.5;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        // The side under the pointer dips away: right of centre → +rotateY, below centre → -rotateX.
        el.style.setProperty("--ry", `${clamp(x * 2 * max).toFixed(2)}deg`);
        el.style.setProperty("--rx", `${clamp(-y * 2 * max).toFixed(2)}deg`);
      });
    };
    const reset = () => {
      cancelAnimationFrame(raf);
      el.style.setProperty("--rx", "0deg");
      el.style.setProperty("--ry", "0deg");
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerleave", reset);
    return () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerleave", reset);
      reset();
    };
  }, [ref, max, reduced]);
}

/**
 * Scroll progress of `ref` through the viewport as a CSS variable (`varName`, default `--p`): 0 when its top meets the
 * viewport bottom, 1 when its bottom meets the viewport top. A rAF-throttled passive listener runs only while the
 * element is on screen. Under reduced motion the variable is left unset, so the CSS fallback (`var(--p, .5)`) applies.
 */
export function useScrollProgress<T extends HTMLElement>(ref: RefObject<T | null>, varName = "--p"): void {
  const reduced = useReducedMotion();
  const inView = useInView(ref, { rootMargin: "0px" });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (reduced) {
      el.style.removeProperty(varName);
      return;
    }
    if (!inView) return;
    let raf = 0;
    const update = () => {
      raf = 0;
      const r = el.getBoundingClientRect();
      const vh = window.innerHeight;
      const p = (vh - r.top) / (vh + r.height);
      el.style.setProperty(varName, Math.max(0, Math.min(1, p)).toFixed(4));
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      cancelAnimationFrame(raf);
    };
  }, [ref, varName, reduced, inView]);
}

/**
 * Fade-up on first sight. Children with `stagger` get `--i` so `.v3-reveal-item` delays step by 70 ms.
 * Never wrap hero text in this: the hero must paint without waiting on JavaScript.
 */
export function Reveal({
  as: Tag = "div",
  className = "",
  children,
  stagger = false,
  style,
}: {
  as?: ElementType;
  className?: string;
  children: ReactNode;
  stagger?: boolean;
  style?: CSSProperties;
}) {
  const ref = useRef<HTMLElement>(null);
  const inView = useInView(ref, { once: true });
  const content = stagger
    ? Children.map(children, (c, i) => (
        <div className="v3-reveal-item" style={{ "--i": i } as Vars}>
          {c}
        </div>
      ))
    : children;
  return (
    <Tag ref={ref} className={`v3-reveal ${stagger ? "v3-reveal-stagger" : ""} ${className}`} data-in={inView ? "" : undefined} style={style}>
      {content}
    </Tag>
  );
}

/**
 * A number that rolls into place digit by digit (odometer). `text` is the formatted value ("$84,061", "2,285");
 * digits roll, everything else is static. Screen readers get the plain text.
 * - `rollIn` (default): rolls up from 0 on first sight, then to each new value, so a live figure visibly ticks.
 * - `rollIn={false}`: the digits sit on their value from the first render (server included) and only roll when
 *   `text` changes, e.g. the hero replica's balances.
 * A change in digit count re-mounts the digits (no roll); same-length changes roll only the digits that moved.
 */
export function RollingNumber({ text, className = "", rollIn = true }: { text: string; className?: string; rollIn?: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true });
  const settled = !rollIn || inView;
  const chars = [...text];
  const digitCount = chars.filter((c) => c >= "0" && c <= "9").length;
  let k = 0;
  return (
    <span ref={ref} className={`v3-odo-wrap ${className}`}>
      <span className="sr-only">{text}</span>
      <span aria-hidden className="v3-odo-line">
        {chars.map((c, i) => {
          if (c < "0" || c > "9") return <span key={`s${i}`}>{c}</span>;
          const idx = k++;
          const d = settled ? Number(c) : 0;
          return (
            <span key={`d${i}-${digitCount}`} className="v3-odo">
              {/* the 0-9 strip is drawn by CSS (.v3-odo-strip::before), so copy, find-in-page and innerText see only `text` */}
              <span className="v3-odo-strip" style={{ "--d": d, "--k": idx } as Vars} />
            </span>
          );
        })}
      </span>
    </span>
  );
}

/**
 * Cycles through `words` in one slot with a short flip, e.g. "DCA into [NVDA]". The slot's width follows the current
 * word. Assistive tech reads the first word only (the rest is decoration).
 * - Uncontrolled (no `index`): its own timer, stopped off-screen and under reduced motion.
 * - Controlled (`index` is a number, e.g. from `useCycleIndex`): shows `words[index % words.length]`, flips on every
 *   change and runs no timer, so something else (a hot tile) can stay in step with it.
 */
export function CycleWord({ words, interval = 1800, className = "", index }: { words: readonly ReactNode[]; interval?: number; className?: string; index?: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const controlled = typeof index === "number";
  const inView = useInView(ref);
  const reduced = useReducedMotion();
  const [own, setOwn] = useState(0);
  useEffect(() => {
    if (controlled || !inView || reduced || words.length < 2) return;
    const t = setInterval(() => setOwn((n) => (n + 1) % words.length), interval);
    return () => clearInterval(t);
  }, [controlled, inView, reduced, words.length, interval]);
  const n = words.length;
  const i = n === 0 ? 0 : (((controlled ? index : own) % n) + n) % n;
  return (
    <span ref={ref} className={`v3-cycle ${className}`}>
      <span key={i} className="v3-cycle-word">
        {words[i]}
      </span>
    </span>
  );
}

/** `id`, `role`, `aria-*` and `data-*` passed through to a primitive's element (e.g. a LiveRegion section's aria-label). */
type PassThrough = { id?: string; role?: string } & { [k: `aria-${string}`]: string | boolean | undefined } & { [k: `data-${string}`]: string | undefined };

/**
 * Adds `data-live` while the element is on screen, so CSS loops (`[data-live] .x { animation-play-state: running }`)
 * pause off-screen. `id`, `role`, `aria-*` and `data-*` pass through to the element.
 */
export function LiveRegion({
  as: Tag = "div",
  className = "",
  children,
  style,
  ...rest
}: { as?: ElementType; className?: string; children: ReactNode; style?: CSSProperties } & PassThrough) {
  const ref = useRef<HTMLElement>(null);
  const inView = useInView(ref, { rootMargin: "0px" });
  return (
    <Tag ref={ref} {...rest} className={className} data-live={inView ? "" : undefined} style={style}>
      {children}
    </Tag>
  );
}

/**
 * `<Countdown>` (components/ui: ticks every second, "due now" past zero) that renders only after mount: the server
 * and the first client paint show the dash placeholder, so a wall-clock value never causes a hydration mismatch.
 */
export function ClientCountdown({ target, className = "" }: { target?: bigint | number; className?: string }) {
  const mounted = useMounted();
  if (!mounted) return <span className="num text-ink-3">—</span>;
  return <Countdown target={target} className={className} />;
}
