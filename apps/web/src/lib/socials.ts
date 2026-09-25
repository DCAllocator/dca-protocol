import { activeChain } from "./chain";

/**
 * Community links shown as icons on the landing pages and in the app sidebar. They are public and the same in every
 * deployment, so they live here rather than in env vars: set `href` when an account exists. On the local test chain
 * (31337: `pnpm dev`, `pnpm share`, both forks) a link without `href` falls back to the platform's home page, so every
 * icon can be seen and clicked before the account exists; on Robinhood Chain it is not shown, and with none set there
 * is no icon row at all.
 */
export type SocialId = "twitter" | "discord" | "telegram" | "github";
export type Social = { id: SocialId; label: string; href: string };

const TEST_ENV = activeChain.id === 31337;

const LINKS: { id: SocialId; label: string; href?: string; placeholder: string }[] = [
  { id: "twitter", label: "X (Twitter)", href: "https://x.com/DCAllocator", placeholder: "https://x.com" },
  { id: "discord", label: "Discord", placeholder: "https://discord.com" },
  { id: "telegram", label: "Telegram", placeholder: "https://t.me" },
  { id: "github", label: "GitHub", href: "https://github.com/DCAllocator/dca-protocol", placeholder: "https://github.com" },
];

/** The links to show, in display order. */
export const SOCIALS: readonly Social[] = LINKS.flatMap(({ id, label, href, placeholder }) => {
  const h = href ?? (TEST_ENV ? placeholder : undefined);
  return h ? [{ id, label, href: h }] : [];
});

export const socialUrl = (id: SocialId) => SOCIALS.find((s) => s.id === id)?.href;
