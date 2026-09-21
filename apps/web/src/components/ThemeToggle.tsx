"use client";

import { Icon } from "@/components/ui";
import { setTheme, useTheme } from "@/lib/theme";

/** Navbar light/dark switch. Shows the register it switches *to* (sun while dark, moon while light). */
export function ThemeToggle() {
  const theme = useTheme();
  const next = theme === "dark" ? "light" : "dark";
  const label = `Switch to ${next} mode`;
  return (
    <button type="button" onClick={() => setTheme(next)} className="btn-ghost h-9 w-9 px-0" aria-label={label} title={label}>
      <Icon name={theme === "dark" ? "sun" : "moon"} />
    </button>
  );
}
