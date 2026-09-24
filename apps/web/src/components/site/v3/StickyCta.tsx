"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { BuyDcaLink } from "@/components/BuyDcaLink";
import { usePlanDraft } from "./PlanDraft";

/** Whether the mobile menu is open: NavV3 flags it on <html data-menu-open>. */
function useMenuOpen(): boolean {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const html = document.documentElement;
    const read = () => setOpen("menuOpen" in html.dataset);
    read();
    const mo = new MutationObserver(read);
    mo.observe(html, { attributes: true, attributeFilter: ["data-menu-open"] });
    return () => mo.disconnect();
  }, []);
  return open;
}

/**
 * The phone-only action bar: Start a plan (or the visitor's drafted plan) beside Buy $DCA, one thumb away once the
 * hero's own buttons have scrolled off the top. It steps aside wherever those actions are already on screen (the
 * closing band #start, the footer) and while the menu sheet is open, and flags `html[data-sticky-cta]` while shown (the
 * nav hides its own Buy $DCA then).
 */
export function StickyCta() {
  const { draft, href } = usePlanDraft();
  const menuOpen = useMenuOpen();
  const [past, setPast] = useState(false);
  const [covered, setCovered] = useState(false);
  const show = past && !covered && !menuOpen;

  // Past the hero: #hero-ctas has left through the top of the viewport.
  useEffect(() => {
    const target = document.getElementById("hero-ctas");
    if (!target) return;
    const io = new IntersectionObserver(([e]) => setPast(!e.isIntersecting && e.boundingClientRect.top < 0));
    io.observe(target);
    return () => io.disconnect();
  }, []);

  // Covered: the closing band or the footer is on screen, each with its own copy of both actions.
  useEffect(() => {
    const targets = [document.getElementById("start"), document.querySelector("[data-v3-footer]")].filter((t): t is Element => !!t);
    const onScreen = new Set<Element>();
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) onScreen.add(e.target);
        else onScreen.delete(e.target);
      }
      setCovered(onScreen.size > 0);
    });
    targets.forEach((t) => io.observe(t));
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    const html = document.documentElement;
    if (show) html.dataset.stickyCta = "";
    else delete html.dataset.stickyCta;
    return () => {
      delete html.dataset.stickyCta;
    };
  }, [show]);

  return (
    <div
      data-show={show ? "" : undefined}
      className="v3-sticky fixed inset-x-0 bottom-0 z-40 grid grid-cols-2 gap-2 border-t border-line bg-surface-0/90 px-4 pt-3 pb-[calc(12px+env(safe-area-inset-bottom))] backdrop-blur md:hidden"
    >
      <Link href={draft.touched ? href : "/app/create"} className="btn-secondary h-11 w-full">
        {draft.touched ? "Start this plan" : "Start a plan"}
      </Link>
      <BuyDcaLink className="btn-primary h-11 w-full" />
    </div>
  );
}
