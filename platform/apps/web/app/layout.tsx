import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono, Space_Grotesk } from "next/font/google";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });
const spaceGrotesk = Space_Grotesk({ subsets: ["latin"], variable: "--font-space-grotesk" });
const jetbrainsMono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains-mono" });

export const metadata: Metadata = {
  title: "Aura Platform — Call Intelligence",
  description: "AI Call Intelligence Platform",
};

/** Explicit so the layout is never rendered at a desktop width on a phone.
 *  maximumScale is left at the default — pinch-zoom stays available. */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#F9F9F9",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${spaceGrotesk.variable} ${jetbrainsMono.variable}`}
    >
      <body className="min-h-dvh bg-[#F9F9F9] text-[#1A1A1A] font-sans antialiased overflow-x-hidden">
        {children}
      </body>
    </html>
  );
}
