"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useDirectory, useVaults } from "@/hooks/useProtocol";
import { Wordmark } from "@/components/Logo";
import { SocialLinks } from "@/components/SocialLinks";
import { Dot, Icon, type IconName } from "@/components/ui";
import { BuyDcaButton } from "@/components/app/create/CreateTabs";
import { fmtUsdCompact } from "@/lib/format";
import { VAULT_META } from "@/lib/config";

const primary: { href: string; label: string; icon: IconName }[] = [
  { href: "/app/plans", label: "My plans", icon: "plans" },
  { href: "/app/activity", label: "Activity", icon: "activity" },
];
const protocol: { href: string; label: string; icon: IconName }[] = [
  { href: "/app", label: "Overview", icon: "overview" },
  { href: "/app/token", label: "DCA Token", icon: "token" },
  { href: "/app/docs", label: "Docs", icon: "docs" },
];

/** Left navigation. Static on ≥ lg, a slide-in drawer below. */
export function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const path = usePathname();
  const { vaults } = useDirectory();
  const { infos } = useVaults(vaults);

  const item = (href: string, label: string, icon: IconName) => {
    const active = path === href;
    return (
      <Link key={href} href={href} onClick={onClose} className={`side-item ${active ? "side-item-active" : ""}`} aria-current={active ? "page" : undefined}>
        <Icon name={icon} className={active ? "text-lime" : "text-ink-3"} />
        {label}
      </Link>
    );
  };

  return (
    <>
      {open && <div className="fixed inset-0 z-40 bg-black/60 lg:hidden" onClick={onClose} aria-hidden />}
      <aside
        className={`fixed inset-y-0 left-0 z-50 flex w-64 shrink-0 flex-col border-r border-line bg-surface-0 transition-transform lg:static lg:translate-x-0 ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex h-16 items-center justify-between px-5">
          <Link href="/" className="flex items-center" onClick={onClose}>
            <Wordmark size={24} />
          </Link>
          <button type="button" onClick={onClose} className="btn-ghost h-8 w-8 px-0 lg:hidden" aria-label="Close menu">
            <Icon name="x" />
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto px-3 pb-4">
          <Link href="/app/create" onClick={onClose} className="btn-primary mb-2 h-10 w-full rounded-lg text-[14px]">
            <Icon name="plus" />
            Create new plan
          </Link>
          <BuyDcaButton onClick={onClose} className="btn-secondary mb-3 h-10 w-full rounded-lg text-[14px]" icon={<Icon name="token" />} />
          <div className="space-y-0.5">{primary.map((n) => item(n.href, n.label, n.icon))}</div>

          <div className="side-label">Protocol</div>
          <div className="space-y-0.5">{protocol.map((n) => item(n.href, n.label, n.icon))}</div>

          <div className="side-label">Vaults</div>
          <div className="space-y-0.5">
            {infos.length === 0 && <div className="px-3 py-1.5 text-[12px] text-ink-3">—</div>}
            {infos.map((v) => (
              <div key={v.kind} className="flex h-9 items-center justify-between px-3 text-[13px]">
                <span className="flex items-center gap-2 text-ink-2">
                  <Dot tone={v.paused ? "warn" : "good"} />
                  {VAULT_META[v.kind].label}
                  {v.kind === "test" && <span className="chip-dev">dev</span>}
                </span>
                {/* USDG waiting to buy on this vault: idle on the vault plus what is lent out for boosted plans. */}
                <span className="num text-[12px] text-ink-3">
                  {v.totalUsdgIdle === undefined ? "—" : fmtUsdCompact(v.totalUsdgIdle + (v.boostAssets ?? 0n))}
                </span>
              </div>
            ))}
          </div>
        </nav>

        <div className="border-t border-line px-5 py-4 text-[11px] leading-relaxed text-ink-3">
          <SocialLinks className="-ml-2 mb-2" />
          Stock Tokens are economic exposure, not shareholder rights. Not offered to US persons. Unaudited software.
        </div>
      </aside>
    </>
  );
}
