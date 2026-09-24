"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import type { Address } from "viem";
import { Wordmark } from "@/components/Logo";
import { BuyDcaLink } from "@/components/BuyDcaLink";
import { SocialIcon, SocialLinks } from "@/components/SocialLinks";
import { LaunchAppLink } from "@/components/site/LandingLive";
import { AddressChip, CaChip } from "./Chips";
import { useDirectory } from "@/hooks/useProtocol";
import { useFeeReceiver } from "@/hooks/useFeeReceiver";
import { activeChain } from "@/lib/chain";
import { ADDRESSES, DOCS_PATH, isZero } from "@/lib/config";
import { useMounted } from "./motion";
import { useContractsLive } from "./shared";
import { IS_RH_MAINNET, LANDING_PATH, SHARE_TEXT, SITE_URL } from "./config";
import "./chrome.css";

/** The site disclaimer, word for word as /legacy (components/site/Sections.tsx) shows it; keep the two in step. */
const DISCLAIMER =
  "Robinhood Stock Tokens are not offered to US persons. This interface is unavailable in the United States, United Kingdom, Canada, Australia and sanctioned regions. Stock Tokens provide economic exposure to the underlying, not shareholder rights. $DCA is a protocol utility token; it is not equity, a security, or a promise of returns. Nothing on this site is investment advice. Smart contracts are unaudited software; use at your own risk. DCA is independent software and is not affiliated with or endorsed by Robinhood.";

const link = "transition-colors hover:text-ink";

function Column({ title, children, className = "" }: { title: string; children: ReactNode; className?: string }) {
  return (
    <div className={className}>
      <h2 className="text-[11px] font-medium uppercase tracking-[0.1em] text-ink-3">{title}</h2>
      <div className="mt-3 grid justify-items-start gap-2 text-[13px] text-ink-2">{children}</div>
    </div>
  );
}

/**
 * "Share on X": a post intent with the share line and the landing's URL (NEXT_PUBLIC_SITE_URL, else this origin once
 * mounted, so the server render never guesses a host).
 */
function useShareHref(): string {
  const mounted = useMounted();
  const url = SITE_URL ?? (mounted ? `${window.location.origin}${LANDING_PATH}` : undefined);
  return `https://x.com/intent/post?text=${encodeURIComponent(url ? `${SHARE_TEXT} ${url}` : SHARE_TEXT)}`;
}

/**
 * The core contracts, each with a copy-and-explorer chip. Only mounted once `useContractsLive()` holds, so the fee
 * receiver is only read then; it is listed only once it answers as a live FeeReceiver, and a zero address is skipped.
 */
function ContractRows() {
  const { dir } = useDirectory();
  const fr = useFeeReceiver(dir);
  const rows: [string, Address | undefined][] = [
    ["$DCA token", dir?.dca],
    ["Vault directory", ADDRESSES.directory],
    ["Hourly vault", dir?.hourly],
    ["Daily vault", dir?.daily],
    ["Weekly vault", dir?.weekly],
    ["Monthly vault", dir?.monthly],
    ["Fee receiver", fr.live ? fr.address : undefined],
  ];
  return (
    // A container query, so every row makes the same call: label beside its chip where the column has room for the
    // longest pair, label above chip where it has not (the three-column tablet layout).
    <ul className="@container mt-3">
      {rows.flatMap(([label, address]) =>
        isZero(address) ? [] : (
          <li
            key={label}
            className="flex flex-col items-start gap-1 py-1.5 text-[12.5px] text-ink-2 @min-[15.5rem]:flex-row @min-[15.5rem]:items-center @min-[15.5rem]:justify-between @min-[15.5rem]:gap-3"
          >
            <span>{label}</span>
            <AddressChip address={address} />
          </li>
        ),
      )}
    </ul>
  );
}

/**
 * The landing footer: the disclaimer verbatim, two link columns, the Core contracts list (gated until the contracts are
 * worth pointing at; one line before that) and a bottom row with the CA check, the chain and the share link.
 * `data-v3-footer` lets the sticky CTA bar step aside once the footer is on screen.
 */
export function FooterV3() {
  // `live` (configured, $DCA deployed, an explorer) gates both the Core contracts list and the line that points at it,
  // so the page never says "check the CA against this page" beside "published here at launch".
  const live = useContractsLive();
  const shareHref = useShareHref();

  return (
    <footer data-v3-footer="" className="border-t border-line bg-surface-0">
      {/* Four columns from xl; below that the disclaimer takes its own row, so it never runs to a 16-line ribbon. */}
      <div className="container-x grid grid-cols-2 gap-x-6 gap-y-10 py-12 md:grid-cols-3 xl:grid-cols-[1.4fr_1fr_1fr_1.2fr] xl:gap-x-10">
        <div className="col-span-2 md:col-span-3 xl:col-span-1">
          <Wordmark />
          <p className="mt-4 max-w-2xl text-[12px] leading-relaxed text-ink-3">{DISCLAIMER}</p>
          <SocialLinks className="-ml-2 mt-5" size={18} />
        </div>

        <Column title="Product">
          <LaunchAppLink className={link}>Open app</LaunchAppLink>
          <Link href="/app/create" className={link}>
            Start a plan
          </Link>
          <BuyDcaLink className={link} />
          <Link href={DOCS_PATH} className={link}>
            Docs
          </Link>
        </Column>

        <Column title="On this page">
          <a href="#how" className={link}>
            How it works
          </a>
          <a href="#stocks" className={link}>
            Stocks
          </a>
          <a href="#dca" className={link}>
            $DCA
          </a>
          <a href="#faq" className={link}>
            FAQ
          </a>
        </Column>

        {/* -m-3 p-3: room for the one-shot :target flash without shifting the column off the grid */}
        <div id="contracts" className="v3-chrome-contracts col-span-2 -m-3 scroll-mt-20 rounded-xl p-3 md:col-span-1">
          <h2 className="text-[11px] font-medium uppercase tracking-[0.1em] text-ink-3">Core contracts</h2>
          {live ? <ContractRows /> : <p className="mt-3 text-[13px] leading-relaxed text-ink-2">Contract addresses are published here at launch.</p>}
        </div>
      </div>

      <div className="border-t border-line">
        <div className="container-x flex flex-col items-start gap-4 pt-5 pb-24 text-[12px] text-ink-3 md:flex-row md:flex-wrap md:items-center md:justify-between md:gap-3 md:pb-5">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            {live && <span>Always check the CA against this page.</span>}
            <CaChip />
          </div>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
            {IS_RH_MAINNET && (
              <span>
                {activeChain.name} · chain ID {activeChain.id}
              </span>
            )}
            <a href={shareHref} target="_blank" rel="noreferrer" className={`inline-flex items-center gap-1.5 ${link}`}>
              <SocialIcon id="twitter" size={12} />
              Share on X
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
}
