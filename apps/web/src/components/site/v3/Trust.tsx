import Link from "next/link";
import { Icon, type IconName } from "@/components/ui";
import { DOCS_PATH } from "@/lib/config";

/*
 * The trust strip: "is my money safe, and is it mine?" in one line. Every claim is one the page already makes in full
 * (the FAQ carries the detail: custody, pause, audit), stated plainly; fees stay in the FAQ. The not-affiliated line
 * lives in the footer disclaimer. Static.
 */

const ITEMS: { icon: IconName; text: string }[] = [
  { icon: "wallet", text: "Non-custodial: only your wallet can withdraw or claim" },
  { icon: "check", text: "Withdraw idle funds any time, even if the protocol is paused" },
  { icon: "external", text: "Every buy and buyback is on-chain" },
  { icon: "info", text: "No external audit yet: only use funds you can afford to lose" },
];

/** "Your plan stays yours.": four facts and the docs, as one compact strip above the FAQ. */
export function Trust() {
  return (
    <section id="trust" className="container-x py-10">
      <h2 className="sr-only">Your plan stays yours.</h2>
      <div className="flex flex-col gap-4 border-y border-line py-5 lg:flex-row lg:items-center lg:justify-between lg:gap-8">
        {/* a 2 x 2 grid from sm, so the second pair lines up under the first */}
        <ul className="grid gap-2.5 text-[13.5px] leading-snug text-ink-2 sm:grid-cols-2 sm:gap-x-8">
          {ITEMS.map((it) => (
            <li key={it.text} className="flex items-start gap-2">
              <Icon name={it.icon} size={16} className="mt-px shrink-0 text-lime-text" />
              {it.text}
            </li>
          ))}
        </ul>
        <Link href={DOCS_PATH} className="shrink-0 text-[13px] text-lime-text hover:underline">
          Read the docs →
        </Link>
      </div>
    </section>
  );
}
