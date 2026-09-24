/**
 * Prelaunch mode (NEXT_PUBLIC_PRELAUNCH=1): the website is live before the protocol and the $DCA token are. Links into
 * the app open a "not launched yet" dialog instead (components/site/PrelaunchGate.tsx) and the middleware sends /app/*
 * back to the landing. No imports, so the edge middleware can read it; same truthy values as `flagOn` in lib/config.
 */
export const PRELAUNCH = ["1", "true", "yes"].includes((process.env.NEXT_PUBLIC_PRELAUNCH ?? "").toLowerCase());

/** Query flag the middleware adds when it redirects an /app visit, so the landing opens the dialog on arrival. */
export const PRELAUNCH_NOTICE_PARAM = "prelaunch";
