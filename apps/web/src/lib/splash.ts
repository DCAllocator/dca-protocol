/**
 * First-load splash constants, kept free of React imports so the root layout (a server component) can inline
 * SPLASH_BOOTSTRAP into <head> next to the theme bootstrap.
 */
export const SPLASH_STORAGE_KEY = "dca:splash";

/** If the app never hydrates, the bootstrap pulls the splash itself after this long. */
const SPLASH_FAILSAFE_MS = 8000;

/**
 * Blocking bootstrap for `<head>`: opts this load into the splash by writing <html data-splash="on"> before
 * first paint. It plays once per browser session (reloads and client-side navigations skip it); `?splash` in
 * the URL forces it. Skipped for reduced motion and for tabs loading in the background (the animation would
 * not run; the session key stays unset so the next visible load gets it). With no JS the markup stays hidden.
 */
export const SPLASH_BOOTSTRAP = `(function(){try{var d=document.documentElement,k=${JSON.stringify(SPLASH_STORAGE_KEY)};if(document.visibilityState==="hidden"||!/[?&]splash(=|&|$)/.test(location.search)&&(sessionStorage.getItem(k)||matchMedia("(prefers-reduced-motion: reduce)").matches))return;sessionStorage.setItem(k,"1");d.dataset.splash="on";setTimeout(function(){if(d.dataset.splash==="on")delete d.dataset.splash},${SPLASH_FAILSAFE_MS})}catch(e){}})()`;
