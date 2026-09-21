"use client";

import { useState, type ReactNode } from "react";
import { useAccount, useConnect } from "wagmi";
import { ConnectButton } from "@/components/ConnectButton";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Sidebar } from "@/components/app/Sidebar";
import { Icon } from "@/components/ui";
import { Logo } from "@/components/Logo";
import { activeChain } from "@/lib/chain";
import { TEST_WALLET_ID } from "@/lib/wagmi";
import { TEST_VAULT } from "@/lib/config";

/** Sidebar + slim header (wallet + theme switch top-right) + centred content column. */
export function AppShell({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const local = activeChain.id === 31337;
  return (
    <div className="flex min-h-dvh bg-surface-1">
      <Sidebar open={open} onClose={() => setOpen(false)} />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-16 shrink-0 items-center gap-3 px-4 md:px-8">
          <button type="button" onClick={() => setOpen(true)} className="btn-ghost h-9 w-9 px-0 lg:hidden" aria-label="Open menu">
            <Icon name="menu" />
          </button>
          <span className="lg:hidden">
            <Logo size={22} />
          </span>
          <div className="ml-auto flex items-center gap-2">
            {local && <TestWallet />}
            {local ? (
              <span className="chip-dev hidden sm:inline-flex">dev · anvil 31337{TEST_VAULT ? " · test vault" : ""}</span>
            ) : (
              <span className="chip hidden sm:inline-flex">
                <span className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-good" />
                {activeChain.name}
              </span>
            )}
            <ConnectButton />
            <ThemeToggle />
          </div>
        </header>
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 pb-20 pt-4 md:px-8">{children}</main>
      </div>
    </div>
  );
}

/** Local-only: connect anvil's funded test wallet without a browser extension. */
function TestWallet() {
  const { isConnected } = useAccount();
  const { connectors, connect, isPending } = useConnect();
  const c = connectors.find((x) => x.id === TEST_WALLET_ID);
  if (!c || isConnected) return null;
  return (
    <button type="button" className="btn-secondary h-9" disabled={isPending} onClick={() => connect({ connector: c })}>
      <span className="sm:hidden">Test wallet</span>
      <span className="hidden sm:inline">Use test wallet</span>
    </button>
  );
}
