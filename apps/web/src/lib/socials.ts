import { activeChain } from "./chain";

/**
 * Community links shown as icons on the landing pages and in the app sidebar. Each is set per deployment with its
 * NEXT_PUBLIC_*_URL (http(s) only). On the local test chain (31337: `pnpm dev`, `pnpm share`, both forks) an unset
 * link falls back to the platform's home page, so the icons can be seen and clicked before the accounts exist; on
 * Robinhood Chain an unset link is not shown, and with none set there is no icon row at all.
 */
export type SocialId = "twitter" | "discord" | "telegram" | "github";
export type Social = { id: SocialId; label: string; href: string };

const url = (v: string | undefined) => (v && /^https?:\/\//.test(v.trim()) ? v.trim() : undefined);
const TEST_ENV = activeChain.id === 31337;

// Each process.env.NEXT_PUBLIC_* is spelled out so Next inlines it into the client bundle.
const LINKS: { id: SocialId; label: string; href: string | undefined; placeholder: string }[] = [
  // NEXT_PUBLIC_X_URL is accepted as an alias.
  { id: "twitter", label: "X (Twitter)", href: url(process.env.NEXT_PUBLIC_TWITTER_URL) ?? url(process.env.NEXT_PUBLIC_X_URL), placeholder: "https://x.com" },
  { id: "discord", label: "Discord", href: url(process.env.NEXT_PUBLIC_DISCORD_URL), placeholder: "https://discord.com" },
  { id: "telegram", label: "Telegram", href: url(process.env.NEXT_PUBLIC_TELEGRAM_URL), placeholder: "https://t.me" },
  // Falls back to the repository URL (NEXT_PUBLIC_REPO_URL).
  { id: "github", label: "GitHub", href: url(process.env.NEXT_PUBLIC_GITHUB_URL) ?? url(process.env.NEXT_PUBLIC_REPO_URL), placeholder: "https://github.com" },
];

/** The links to show, in display order. */
export const SOCIALS: readonly Social[] = LINKS.flatMap(({ id, label, href, placeholder }) => {
  const h = href ?? (TEST_ENV ? placeholder : undefined);
  return h ? [{ id, label, href: h }] : [];
});

export const socialUrl = (id: SocialId) => SOCIALS.find((s) => s.id === id)?.href;
