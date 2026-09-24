"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useAccount } from "wagmi";
import { useDirectory, useVaults, useStocks, useBoostApys, usePositions, useKindsBuying, boostAvailable, findStock } from "@/hooks/useProtocol";
import { BoostShowcase } from "@/components/site/BoostShowcase";

/** How long a click waits for the wallet / positions before giving up and going to Create plan. */
const LAUNCH_WAIT_MS = 3_000;

/** Create plan with `symbol` preselected (see `useStockParam`); the landing pages link it through `useStockHref`. */
export const createPlanHref = (symbol: string) => `/app/create?stock=${encodeURIComponent(symbol)}`;

/**
 * Where a landing-page ticker links: Create plan on that stock (`createPlanHref`) when some production vault buys it
 * (`useKindsBuying`), else plain Create plan, since a deep link to a stock nothing buys would only open on a notice.
 * Plain until the stock list and the keeper's pairs are in.
 */
export function useStockHref() {
  const { dir } = useDirectory();
  const { stocks } = useStocks(dir?.registry);
  const { kindsBuying } = useKindsBuying();
  return useCallback(
    (symbol: string) => {
      const s = findStock(stocks, symbol);
      return s && kindsBuying(s.address)?.length ? createPlanHref(symbol) : "/app/create";
    },
    [stocks, kindsBuying],
  );
}

/**
 * "Launch app" lands where the visitor should start: My plans when the connected wallet already has plans,
 * Create plan otherwise (including with no wallet connected). The wallet reconnects and positions load on the
 * landing page itself, so the answer is usually known before the click; a click that arrives while either is
 * still pending waits for the answer instead of guessing, capped at LAUNCH_WAIT_MS.
 */
export function LaunchAppLink({ className, children }: { className?: string; children: ReactNode }) {
  const router = useRouter();
  const { address, isReconnecting } = useAccount();
  const { vaults, configured } = useDirectory();
  const { positions, isLoading } = usePositions(vaults);
  const pending = isReconnecting || (!!address && configured && (!vaults || isLoading));
  const href = address && positions.length > 0 ? "/app/plans" : "/app/create";
  const [clicked, setClicked] = useState(false);

  useEffect(() => {
    if (!clicked) return;
    if (!pending) {
      router.push(href);
      return;
    }
    const t = setTimeout(() => router.push("/app/create"), LAUNCH_WAIT_MS);
    return () => clearTimeout(t);
  }, [clicked, pending, href, router]);

  return (
    <Link
      href={href}
      className={className}
      aria-busy={clicked && pending ? true : undefined}
      onClick={(e) => {
        if (!pending) return;
        e.preventDefault();
        setClicked(true);
      }}
    >
      {children}
    </Link>
  );
}

/**
 * The landing's Boost card, with the live Morpho supply APY of the first vault that has a boost strategy (they lend
 * into the same USDG market). Drawn by BoostShowcase in the Boost dialog's celebration style.
 */
export function BoostTeaser() {
  const { vaults } = useDirectory();
  const { infos } = useVaults(vaults);
  const { apyOf } = useBoostApys(infos);
  const withBoost = infos.find(boostAvailable);
  return <BoostShowcase apy={apyOf(withBoost?.boostStrategy)} />;
}
