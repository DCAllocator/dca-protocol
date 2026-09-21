/**
 * Theme constants shared by the server layout and the client theme store (lib/theme.ts). Kept free of
 * React imports so the root layout (a server component) can inline THEME_BOOTSTRAP into <head>.
 */
export const THEME_STORAGE_KEY = "dca:theme";
export const DARK_MEDIA = "(prefers-color-scheme: dark)";

/** Blocking bootstrap for `<head>`: stored choice, else the OS preference, written to <html data-theme> before paint. */
export const THEME_BOOTSTRAP = `(function(){try{var s=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});var t=s==="light"||s==="dark"?s:(matchMedia(${JSON.stringify(DARK_MEDIA)}).matches?"dark":"light");document.documentElement.dataset.theme=t}catch(e){}})()`;
