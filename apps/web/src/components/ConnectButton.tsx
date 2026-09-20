"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAccount, useConnect, useDisconnect, useSwitchChain, type Connector } from "wagmi";
import { activeChain } from "@/lib/chain";
import { short } from "@/lib/format";

/** Discovered wallets first (they carry an icon); fall back to the generic connector only when nothing was found. */
function pickableConnectors(connectors: readonly Connector[]): Connector[] {
  const discovered = connectors.filter((c) => c.id !== "injected");
  return discovered.length > 0 ? discovered : connectors.filter((c) => c.id === "injected");
}

export function ConnectButton({ className = "" }: { className?: string }) {
  const { address, isConnected, chainId, connector } = useAccount();
  const { connect, connectors, isPending, error: connectError } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: switching } = useSwitchChain();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open || !btn.current) return;
    const r = btn.current.getBoundingClientRect();
    setPos({ top: r.bottom + 4, right: Math.max(8, window.innerWidth - r.right) });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!btn.current?.contains(t) && !pop.current?.contains(t)) close();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  if (!isConnected || !address) {
    const list = pickableConnectors(connectors);
    const choose = (c: Connector) => {
      setOpen(false);
      connect({ connector: c });
    };
    return (
      <>
        <button
          ref={btn}
          type="button"
          className={`btn-primary ${className}`}
          disabled={isPending || list.length === 0}
          onClick={() => (list.length === 1 ? choose(list[0]) : setOpen((o) => !o))}
          title={list.length === 0 ? "No wallet extension detected" : undefined}
        >
          {isPending ? "Connecting…" : list.length === 0 ? "No wallet found" : "Connect wallet"}
        </button>
        {open &&
          pos &&
          createPortal(
            <div ref={pop} role="menu" className="menu fixed w-48" style={{ top: pos.top, right: pos.right }}>
              <div className="px-3 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-3">Choose a wallet</div>
              {list.map((c) => (
                <button key={c.uid} role="menuitem" className="menu-item gap-2" onClick={() => choose(c)}>
                  {c.icon ? (
                    // eslint-disable-next-line @next/next/no-img-element -- wallet icons are extension-supplied data/blob URIs
                    <img src={c.icon} alt="" width={16} height={16} className="rounded-sm" />
                  ) : (
                    <span className="h-2 w-2 rounded-full bg-ink-3" />
                  )}
                  {c.name}
                </button>
              ))}
              {connectError && <div className="px-3 py-1.5 text-[12px] text-bad">{connectError.message.split("\n")[0]}</div>}
            </div>,
            document.body,
          )}
      </>
    );
  }

  if (chainId !== activeChain.id) {
    return (
      <button type="button" className={`btn-primary ${className}`} disabled={switching} onClick={() => switchChain({ chainId: activeChain.id })}>
        {switching ? "Check your wallet…" : `Switch to ${activeChain.name}`}
      </button>
    );
  }

  return (
    <button
      type="button"
      className={`btn-secondary gap-2 ${className}`}
      onClick={() => disconnect()}
      title={`Connected via ${connector?.name ?? "wallet"} — click to disconnect`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-good" />
      {short(address)}
    </button>
  );
}
