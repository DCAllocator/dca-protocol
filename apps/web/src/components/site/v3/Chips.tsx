"use client";

import { useState } from "react";
import { useDirectory } from "@/hooks/useProtocol";
import { isZero } from "@/lib/config";
import { short } from "@/lib/format";
import { PONS_URL, explorerAddress } from "./config";

/*
 * Contract chips for the landing: the $DCA contract address (nav, $DCA section, closing band, footer) and the footer's
 * Core contracts rows. A click copies the full address; the explorer link beside it only shows once the chain has one.
 */

function useCopy(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  const copy = (text: string) => {
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };
  return [copied, copy];
}

function IconCopy({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M10.5 5.5V3.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" />
    </svg>
  );
}

function IconExt({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
      <path d="M6 3H3.5A1.5 1.5 0 0 0 2 4.5v8A1.5 1.5 0 0 0 3.5 14h8a1.5 1.5 0 0 0 1.5-1.5V10M9 2h5v5M14 2 7 9" />
    </svg>
  );
}

/** Address chip: click copies the full address; optional explorer link beside it. */
export function AddressChip({ label, address, link = true }: { label?: string; address?: string; link?: boolean }) {
  const [copied, copy] = useCopy();
  const ex = link ? explorerAddress(address) : undefined;
  if (!address) {
    return (
      <span className="inline-flex h-7 items-center gap-1.5 rounded-md border border-line px-2 text-[12px] text-ink-3">
        {label && <span className="text-ink-3">{label}</span>}
        <span>deploys with launch</span>
      </span>
    );
  }
  return (
    <span className="inline-flex h-7 items-center overflow-hidden rounded-md border border-line text-[12px]">
      {label && <span className="border-r border-line bg-surface-2 px-2 text-ink-3">{label}</span>}
      <button type="button" onClick={() => copy(address)} className="inline-flex h-full items-center gap-1.5 px-2 text-ink hover:bg-hover" title="Copy address">
        {copied ? <span className="text-lime">Copied</span> : short(address)}
        <span className="text-ink-3">
          <IconCopy />
        </span>
      </button>
      {ex && (
        <a href={ex} target="_blank" rel="noreferrer" className="inline-flex h-full items-center border-l border-line px-2 text-ink-3 hover:bg-hover hover:text-ink" title="Open on the explorer">
          <IconExt />
        </a>
      )}
    </span>
  );
}

/** The $DCA contract chip: the address once deployed, the Pons link before that, plain text before either. */
export function CaChip() {
  const { dir } = useDirectory();
  const dca = dir && !isZero(dir.dca) ? dir.dca : undefined;
  if (dca) return <AddressChip label="$DCA" address={dca} />;
  if (PONS_URL)
    return (
      <a href={PONS_URL} target="_blank" rel="noreferrer" className="inline-flex h-7 items-center gap-1.5 rounded-md border border-line px-2 text-[12px] text-ink-2 hover:border-ink hover:text-ink">
        Launching on Pons <IconExt />
      </a>
    );
  return <span className="inline-flex h-7 items-center rounded-md border border-line px-2 text-[12px] text-ink-3">CA at launch</span>;
}
