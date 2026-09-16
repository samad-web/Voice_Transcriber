import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono, Space_Grotesk } from "next/font/google";
import { ConfirmProvider, FeedbackProvider } from "@aura/ui";
import { InfoHintsProvider } from "@/components/info-hints-provider";
import { ThemeProvider } from "@/components/theme-provider";
import { readInfoHintsPreference } from "@/lib/info-hints-cookie";
import { readThemePreference } from "@/lib/theme-cookie";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });
const spaceGrotesk = Space_Grotesk({ subsets: ["latin"], variable: "--font-space-grotesk" });
const jetbrainsMono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains-mono" });

export const metadata: Metadata = {
  title: "Aura Platform - Call Intelligence",
  description: "AI Call Intelligence Platform",
};

/** Explicit so the layout is never rendered at a desktop width on a phone.
 *  maximumScale is left at the default - pinch-zoom stays available. Two
 *  themeColor entries, not one, so the browser chrome (status bar, address
 *  bar) matches the page in both modes instead of staying light-mode grey
 *  over a dark console. */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#F9F9F9" },
    { media: "(prefers-color-scheme: dark)", color: "#0A0A0A" },
  ],
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Read once, at the root, so every route group's first paint already
  // carries the right `data-theme` - see doc 16 §1.6's "persisted in a cookie
  // so the server render matches and there is no flash". Undefined (not
  // "light") when there is no cookie: the attribute is then absent entirely
  // and theme.css's `prefers-color-scheme` block decides instead.
  const theme = await readThemePreference();
  const infoHints = await readInfoHintsPreference();

  return (
    <html
      lang="en"
      data-theme={theme ?? undefined}
      className={`${inter.variable} ${spaceGrotesk.variable} ${jetbrainsMono.variable}`}
    >
      <body className="min-h-dvh bg-bg text-text font-sans antialiased overflow-x-hidden">
        <ThemeProvider initialTheme={theme}>
          {/* At the ROOT, not in (owner)/ and (platform)/ separately: both route
              groups have destructive actions, and one provider means one dialog
              in the DOM rather than two that could ever both be open. Feedback
              sits inside for the same reason - one toast stack for the app, and
              one live region that exists before anything is announced into it. */}
          <ConfirmProvider>
            <FeedbackProvider>
              <InfoHintsProvider initialEnabled={infoHints}>{children}</InfoHintsProvider>
            </FeedbackProvider>
          </ConfirmProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
