"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Wordmark } from "@/components/Logo";
import { ThemeToggle } from "@/components/ThemeToggle";
import { BuyDcaLink } from "@/components/BuyDcaLink";
import { SocialLinks } from "@/components/SocialLinks";
import { Icon } from "@/components/ui";
import { LaunchAppLink } from "@/components/site/LandingLive";
import { CaChip } from "./Chips";
import { DOCS_PATH } from "@/lib/config";
import { ChartLink } from "./shared";
import { LANDING_PATH } from "./config";
import "./chrome.css";

/** The on-page sections the nav points at. */
const ANCHORS: readonly (readonly [href: string, label: string])[] = [
  ["#how", "How it works"],
  ["#stocks", "Stocks"],
  ["#dca", "$DCA"],
  ["#faq", "FAQ"],
];

/** True once the page has scrolled past `offset` px; read at most once a frame from a passive listener. */
function useScrolled(offset = 8): boolean {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    let raf = 0;
    const read = () => {
      raf = 0;
      setScrolled(window.scrollY > offset);
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(read);
    };
    read();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(raf);
    };
  }, [offset]);
  return scrolled;
}

/**
 * The landing header: wordmark, the four section anchors, the $DCA contract chip and both actions, over a progressive
 * blur that firms up (background + hairline) once the page scrolls. Under md the anchors, Open app, the CA chip and
 * the theme switch move into a sheet behind the menu button; Buy $DCA stays in the bar at every width.
 *
 * The sheet is a disclosure (button with aria-expanded / aria-controls), not a modal: it closes on a link tap,
 * Escape, a scrim tap or when focus leaves the header, and flags `html[data-menu-open]` while open so the sticky CTA
 * bar steps aside.
 */
export function NavV3() {
  const scrolled = useScrolled();
  const [open, setOpen] = useState(false);
  const header = useRef<HTMLElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const firstLink = useRef<HTMLAnchorElement>(null);

  /** Closes the sheet; focus returns to the menu button unless the close came from following a link. */
  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) button.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    if (!open) return;
    const html = document.documentElement;
    html.dataset.menuOpen = "";
    firstLink.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close(true);
    };
    // Growing past md hides the sheet with CSS; drop the open state with it so the flag never lingers.
    const wide = window.matchMedia("(min-width: 768px)");
    const onWide = () => {
      if (wide.matches) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    wide.addEventListener("change", onWide);
    return () => {
      delete html.dataset.menuOpen;
      document.removeEventListener("keydown", onKey);
      wide.removeEventListener("change", onWide);
    };
  }, [open, close]);

  // A followed link closes the sheet without pulling focus back: an anchor has just moved the reading position to
  // its section, and Docs leaves the page.
  const follow = () => close(false);

  return (
    <header
      ref={header}
      data-scrolled={scrolled ? "" : undefined}
      onBlur={(e) => {
        if (open && e.relatedTarget instanceof Node && !header.current?.contains(e.relatedTarget)) setOpen(false);
      }}
      // Unscrolled, only the body (surface-1) sits under the in-flow header, so it is opaque there to meet the hero
      // without a seam; once content slides under it turns to glass.
      className="sticky top-0 z-40 h-14 border-b border-transparent bg-surface-0 transition-[background-color,border-color] duration-200 motion-reduce:transition-none data-[scrolled]:border-line data-[scrolled]:bg-surface-0/85"
    >
      <div className="v3-blur-stack" aria-hidden>
        <i />
        <i />
        <i />
      </div>

      <div className="container-x flex h-14 items-center">
        <Link href={LANDING_PATH} aria-label="DCA home" onClick={() => setOpen(false)} className="rounded-md">
          <Wordmark size={24} />
        </Link>

        <nav className="ml-8 hidden items-center gap-6 text-[13px] text-ink-2 md:flex">
          {ANCHORS.map(([href, label]) => (
            <a key={href} href={href} className="transition-colors hover:text-ink">
              {label}
            </a>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-2">
          <SocialLinks className="mr-1 hidden xl:flex" />
          <span className="hidden lg:inline-flex">
            <CaChip />
          </span>
          <ChartLink className="hidden text-[12px] text-ink-3 transition-colors hover:text-ink lg:inline-flex" />
          <LaunchAppLink className="btn-secondary hidden md:inline-flex">Open app</LaunchAppLink>
          {/* v3-nav-buy: hidden on phones while the sticky bar (which carries Buy $DCA) is up; see chrome.css */}
          <BuyDcaLink className="v3-nav-buy btn-primary px-3 text-[13px] md:px-3.5 md:text-[13.5px]" />
          <span className="hidden md:inline-flex">
            <ThemeToggle />
          </span>
          <button
            ref={button}
            type="button"
            onClick={() => (open ? close(true) : setOpen(true))}
            aria-expanded={open}
            aria-controls="v3-menu"
            aria-label={open ? "Close menu" : "Open menu"}
            className="-mr-2 inline-flex h-10 w-10 items-center justify-center rounded-lg text-ink transition-colors hover:bg-hover md:hidden"
          >
            <Icon name={open ? "x" : "menu"} size={18} />
          </button>
        </div>
      </div>

      <div aria-hidden hidden={!open} onClick={() => close(true)} className="v3-chrome-scrim fixed inset-0 top-14 z-30 bg-black/40 md:hidden" />
      <div id="v3-menu" hidden={!open} className="anim-dialog-in fixed inset-x-0 top-14 z-40 max-h-[calc(100dvh-3.5rem)] overflow-y-auto border-b border-line bg-surface-0 md:hidden">
        <nav>
          {ANCHORS.map(([href, label], i) => (
            <a
              key={href}
              ref={i === 0 ? firstLink : undefined}
              href={href}
              onClick={follow}
              className="flex h-12 items-center border-b border-line px-6 text-[16px] text-ink transition-colors hover:bg-hover"
            >
              {label}
            </a>
          ))}
          <Link href={DOCS_PATH} onClick={follow} className="flex h-12 items-center border-b border-line px-6 text-[16px] text-ink transition-colors hover:bg-hover">
            Docs
          </Link>
        </nav>
        <div className="grid gap-3 p-6">
          <LaunchAppLink className="btn-secondary btn-lg w-full">Open app</LaunchAppLink>
          {/* Chip and theme switch share a row; the social icons get their own, since all three overflow a 390px phone. */}
          <div className="flex items-center justify-between gap-3">
            <span className="inline-flex shrink-0 whitespace-nowrap">
              <CaChip />
            </span>
            <ThemeToggle />
          </div>
          <SocialLinks className="-ml-2" size={18} />
        </div>
      </div>
    </header>
  );
}
