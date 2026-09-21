"use client";

import { useEffect, useSyncExternalStore } from "react";
import { DARK_MEDIA, THEME_STORAGE_KEY } from "@/lib/theme-bootstrap";

/**
 * Light / dark register. The resolved theme lives on `<html data-theme>`: THEME_BOOTSTRAP (theme-bootstrap.ts)
 * sets it in <head> before first paint (stored choice, else the OS preference), so there is no flash, and
 * the tokens in globals.css key off the attribute (no attribute = dark). This module is the one writer after that.
 */
export type Theme = "light" | "dark";

const listeners = new Set<() => void>();

const read = (): Theme => (document.documentElement.dataset.theme === "light" ? "light" : "dark");

function apply(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  listeners.forEach((l) => l());
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Explicit choice from the switcher: persists, and stops following the OS until storage is cleared. */
export function setTheme(theme: Theme) {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    /* private mode / blocked storage: the choice still applies for this page */
  }
  apply(theme);
}

/** Resolved theme. Server-rendered and hydrated as dark (the CSS default), then corrected from the DOM. */
export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, read, () => "dark");
}

/** Mount once (Providers): while no choice is stored, follow OS light/dark changes live. */
export function useSystemThemeSync() {
  useEffect(() => {
    const mq = matchMedia(DARK_MEDIA);
    const onChange = () => {
      let stored: string | null = null;
      try {
        stored = localStorage.getItem(THEME_STORAGE_KEY);
      } catch {}
      if (stored !== "light" && stored !== "dark") apply(mq.matches ? "dark" : "light");
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
}
