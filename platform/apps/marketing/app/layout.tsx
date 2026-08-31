import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { SiteHeader, SkipLink } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";
import { MetaPixel } from "@/components/meta-pixel";
import { GoogleTagManager } from "@/components/google-tag-manager";
import { MicrosoftClarity } from "@/components/microsoft-clarity";
import { BRAND, SITE_URL } from "@/lib/site";

/**
 * Type - Inter, one family for everything (doc 16 §1.2).
 *
 * `next/font/google` is NOT a CDN link. It downloads the woff2 at build time,
 * fingerprints it, emits it into the app's own static output and serves it from
 * this origin with `font-display: swap` and a preload. The browser makes zero
 * requests to any Google host, sets no Google cookie and leaks no visitor IP -
 * which is the property doc 10 §9 and the site's privacy posture actually
 * require. `subsets: ["latin"]` is the subsetting.
 *
 * The residual cost is a network fetch during `next build`. Vendoring the woff2
 * into app/fonts/ and switching to `next/font/local` removes even that; it is
 * in the run report's followUps, and needs a binary this run could not produce.
 */
const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-inter",
});

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: `${BRAND}: call intelligence for sales teams in India`,
    template: `%s | ${BRAND}`,
  },
  description:
    "Aura records your telecallers' calls, transcribes them in Tamil and English, " +
    "and turns every conversation into a qualified lead in your CRM.",
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // One per mode, so the browser chrome matches the ground the page renders on.
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#FFFFFF" },
    { media: "(prefers-color-scheme: dark)", color: "#0A0A0A" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // No `data-theme` is written here. This app has no theme toggle and no
    // cookie, so it follows prefers-color-scheme and the server render can
    // never disagree with the client - there is nothing to flash. The console
    // owns the explicit override (doc 16 §1.6); the tokens support it already.
    <html lang="en" className={inter.variable}>
      <body className="min-h-dvh bg-bg font-sans text-lg text-text antialiased">
        <SkipLink />
        <SiteHeader />
        <main id="main">{children}</main>
        <SiteFooter />
        {/* All three fire on load. Each renders nothing unless its own id is
            set at BUILD time (NEXT_PUBLIC_META_PIXEL_ID / NEXT_PUBLIC_GTM_ID /
            NEXT_PUBLIC_CLARITY_PROJECT_ID), so a developer machine or preview
            build sends no events anywhere.

            The consent banner that used to sit here was removed when the gate
            came off: a Decline button that stops nothing is a written promise
            the site does not keep. /security still discloses what these do. */}
        <MetaPixel />
        <GoogleTagManager />
        <MicrosoftClarity />
      </body>
    </html>
  );
}
