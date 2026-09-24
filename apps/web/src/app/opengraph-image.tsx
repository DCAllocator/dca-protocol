import { ImageResponse } from "next/og";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/*
 * The site's share card (X, Telegram, Discord): the H1, the subhead and four stock marks on the site's dark
 * surface. Static: prerendered at build, so it never reads the chain and never needs a live number. The marks and the
 * logo are read from /public and inlined as data URLs (Node runtime, the default for metadata images).
 */

export const alt = "The token that $DCA's itself. Wall Street stocks, automatically bought on-chain.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const BG = "#0c0c0b";
const INK = "#ededea";
const INK_2 = "#a7a5a0";
const INK_3 = "#7b7975";
const LIME = "#ccff00";

/**
 * The site's 48px hairline grid (.v3-grid), faded out from the top-right corner: public/og-grid.svg, since satori has no
 * CSS mask. A static file rather than an inline string: the production minifier mangled the inline SVG's markup.
 */
const GRID_W = 768;
const GRID_H = 480;

/**
 * Four marks that read at thumbnail size, on the dark register (see lib/tickers.ts). SPY and GLD share one file, the
 * State Street SPDR wordmark, which shrinks to an unreadable line at this size, so GOOGL and AAPL stand in for them.
 */
const MARKS = ["NVDA.svg", "TSLA.svg", "AAPL-dark.svg", "GOOGL.svg"];

const LINE_1 = "The token that";
const LINE_1B = "$DCA's itself.";
const LINE_2 = "Wall Street stocks, automatically bought on-chain.";
const FOOTER = "Robinhood Chain";

async function dataUrl(file: string, mime: string): Promise<string> {
  const buf = await readFile(join(process.cwd(), "public", file));
  return `data:${mime};base64,${buf.toString("base64")}`;
}

type Font = { name: string; data: ArrayBuffer; weight: 500 | 600; style: "normal" };

/**
 * Inter (the site face) subset to just the card's glyphs, fetched once at build like the root layout's next/font. Any
 * failure (offline build, timeout) returns no fonts and ImageResponse falls back to its bundled Noto Sans. The card
 * names "Inter" either way: satori falls back to the fonts it has, but throws on an undefined fontFamily.
 */
async function interFonts(): Promise<Font[]> {
  try {
    const text = encodeURIComponent(LINE_1 + LINE_1B + LINE_2 + FOOTER);
    const css = await fetch(`https://fonts.googleapis.com/css2?family=Inter:wght@500;600&text=${text}`, { signal: AbortSignal.timeout(4000) }).then((r) => (r.ok ? r.text() : ""));
    const faces = [...css.matchAll(/font-weight:\s*(\d+);[^}]*?src:\s*url\(([^)]+)\)\s*format\('(?:truetype|opentype)'\)/g)];
    const fonts = await Promise.all(
      faces.map(async ([, weight, url]): Promise<Font> => {
        const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
        if (!res.ok) throw new Error(`font ${res.status}`);
        return { name: "Inter", data: await res.arrayBuffer(), weight: Number(weight) as 500 | 600, style: "normal" };
      }),
    );
    return fonts.length === 2 ? fonts : [];
  } catch {
    return [];
  }
}

export default async function Image() {
  const [logo, grid, marks, fonts] = await Promise.all([
    dataUrl("logo.png", "image/png"),
    dataUrl("og-grid.svg", "image/svg+xml"),
    Promise.all(MARKS.map((m) => dataUrl(`tickers/${m}`, "image/svg+xml"))),
    interFonts(),
  ]);

  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", position: "relative", background: BG, fontFamily: "Inter", padding: "64px 72px 60px" }}>
        {/* faint 48px grid, top-right */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={grid} alt="" width={GRID_W} height={GRID_H} style={{ position: "absolute", top: 0, right: 0, width: GRID_W, height: GRID_H }} />
        {/* the lime wash the site puts behind its hero objects */}
        <div
          style={{
            position: "absolute",
            right: 0,
            bottom: 0,
            width: 900,
            height: 520,
            display: "flex",
            backgroundImage: "radial-gradient(60% 70% at 100% 100%, rgba(204,255,0,0.13), rgba(204,255,0,0) 70%)",
          }}
        />

        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={logo} alt="" width={64} height={64} style={{ width: 64, height: 64 }} />

        <div style={{ display: "flex", flexDirection: "column", marginTop: "auto" }}>
          <div style={{ display: "flex", flexDirection: "column", fontSize: 76, fontWeight: 600, lineHeight: 1.04, letterSpacing: "-0.03em", color: INK }}>
            <span>{LINE_1}</span>
            <span style={{ display: "flex" }}>
              <span style={{ color: LIME }}>$DCA&apos;s</span>
              <span style={{ marginLeft: "0.25em" }}>itself.</span>
            </span>
          </div>
          <div style={{ display: "flex", marginTop: 26, fontSize: 34, fontWeight: 500, letterSpacing: "-0.015em", color: INK_2 }}>{LINE_2}</div>
        </div>

        <div style={{ display: "flex", alignItems: "center", marginTop: 52 }}>
          <div style={{ display: "flex", gap: 14 }}>
            {marks.map((src, i) => (
              <div key={MARKS[i]} style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 76, height: 76, borderRadius: 18, background: "#161614", border: "1px solid rgba(255,255,255,0.11)" }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={src} alt="" width={56} height={56} style={{ width: 56, height: 56 }} />
              </div>
            ))}
          </div>
          <div style={{ display: "flex", alignItems: "center", marginLeft: "auto", fontSize: 22, fontWeight: 500, color: INK_3 }}>
            <div style={{ width: 10, height: 10, borderRadius: 999, background: LIME, marginRight: 12 }} />
            {FOOTER}
          </div>
        </div>
      </div>
    ),
    // An empty list would leave satori with no font at all; undefined lets ImageResponse use its bundled one.
    { ...size, fonts: fonts.length ? fonts : undefined },
  );
}
