"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { useAccount } from "wagmi";
import { useDirectory, usePositions } from "@/hooks/useProtocol";

/** How long a click waits for the wallet / positions before giving up and going to Create plan. */
const LAUNCH_WAIT_MS = 3_000;

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
