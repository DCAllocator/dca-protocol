"use client";

import { useCallback, useEffect, useState } from "react";
import { Modal } from "@/components/ui";
import { SocialIcon } from "@/components/SocialLinks";
import { CHART_URL, PONS_URL } from "@/components/site/v3/config";
import { BUY_DCA_URL } from "@/lib/config";
import { PRELAUNCH, PRELAUNCH_NOTICE_PARAM } from "@/lib/prelaunch";
import { socialUrl } from "@/lib/socials";

/** Off-site pages that only make sense once the token exists (its Pons listing, its chart). */
const TOKEN_PAGES = [PONS_URL, CHART_URL, BUY_DCA_URL].filter((u): u is string => !!u && /^https?:\/\//.test(u));

/** A link the dialog stands in for: any page of the app (/app/*) or one of the token's off-site pages. */
function gated(href: string) {
  const url = new URL(href, window.location.href);
  if (url.origin === window.location.origin) return url.pathname === "/app" || url.pathname.startsWith("/app/");
  return TOKEN_PAGES.some((p) => href.startsWith(p));
}

/** "@handle" from an x.com / twitter.com profile URL, when it has one. */
function handleOf(href: string | undefined) {
  const name = href ? new URL(href).pathname.split("/").filter(Boolean)[0] : undefined;
  return name ? `@${name}` : undefined;
}

/**
 * Prelaunch mode (lib/prelaunch.ts). Clicks on links into the app or to the token's off-site pages (plain, middle and
 * modifier clicks alike) open a "not launched yet" dialog pointing to X instead of navigating; in-page anchors, the
 * community links and everything else still work. Also opens on arrival when the middleware redirected an /app visit
 * here. Renders nothing while the flag is off.
 */
export function PrelaunchGate() {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!PRELAUNCH) return;
    const url = new URL(window.location.href);
    if (url.searchParams.has(PRELAUNCH_NOTICE_PARAM)) {
      setOpen(true);
      url.searchParams.delete(PRELAUNCH_NOTICE_PARAM);
      window.history.replaceState(window.history.state, "", url);
    }
    // Capture phase on the document, so this runs before Next's <Link> handler and the browser's default action.
    const onClick = (e: MouseEvent) => {
      if (e.type === "auxclick" && e.button !== 1) return;
      const a = e.target instanceof Element ? e.target.closest("a[href]") : null;
      if (!(a instanceof HTMLAnchorElement) || !gated(a.href)) return;
      e.preventDefault();
      e.stopPropagation();
      setOpen(true);
    };
    document.addEventListener("click", onClick, true);
    document.addEventListener("auxclick", onClick, true);
    return () => {
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("auxclick", onClick, true);
    };
  }, []);

  if (!PRELAUNCH) return null;
  const x = socialUrl("twitter");
  const handle = handleOf(x);
  return (
    <Modal open={open} onClose={close} title="Not launched yet">
      <p className="text-[14px] leading-relaxed text-ink-2">
        The $DCA token and the DCA protocol haven&apos;t launched yet.
        {x ? <> Follow {handle ?? "us"} on X to hear the moment they go live.</> : <> Check back soon.</>}
      </p>
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <button type="button" onClick={close} className="btn-secondary">
          Close
        </button>
        {x && (
          <a href={x} target="_blank" rel="noreferrer" onClick={close} className="btn-primary gap-2">
            <SocialIcon id="twitter" size={14} />
            Follow {handle ?? "on X"}
          </a>
        )}
      </div>
    </Modal>
  );
}
