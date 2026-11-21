import type { Metadata, Viewport } from "next";
import { EB_Garamond, Instrument_Sans } from "next/font/google";
import "@rainbow-me/rainbowkit/styles.css";
import "./globals.css";
// Validates required env vars at app boot — see lib/env.ts
import "@/lib/env";
import { ServiceWorkerRegister } from "@/components/pwa/ServiceWorkerRegister";
import { NewsNote } from "@/components/techne/NewsNote";
import { OG_IMAGES, SITE_DESCRIPTION, siteUrl } from "@/lib/metadata";

// The book's type (T-482): EB Garamond sets the site; Instrument Sans is the plain sans of the portal and admin's
// working screens (globals.css, [data-surface="work"]). Both are open-licence (OFL), self-hosted by next/font, subset
// to Latin, font-display swap. Only Garamond is preloaded: public pages never use the sans, so they never fetch it.
const garamond = EB_Garamond({
  subsets: ["latin"],
  style: ["normal", "italic"],
  display: "swap",
  variable: "--font-book",
  fallback: ["Iowan Old Style", "Palatino Linotype", "Georgia", "serif"],
});
const instrumentSans = Instrument_Sans({
  subsets: ["latin"],
  display: "swap",
  preload: false,
  variable: "--font-work",
  fallback: ["system-ui", "Segoe UI", "Helvetica Neue", "Arial", "sans-serif"],
});

export const metadata: Metadata = {
  // Makes the relative og:image below resolve to an absolute URL, which is the
  // only kind a social crawler will fetch.
  metadataBase: siteUrl(),
  title: "RegenHub Boulder",
  description: SITE_DESCRIPTION,
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "RegenHub",
  },
  openGraph: {
    type: "website",
    title: "RegenHub Boulder",
    description: SITE_DESCRIPTION,
    siteName: "RegenHub Boulder",
    images: OG_IMAGES,
  },
  twitter: {
    card: "summary_large_image",
    title: "RegenHub Boulder",
    description: SITE_DESCRIPTION,
    images: OG_IMAGES,
  },
};

export const viewport: Viewport = {
  themeColor: "#ebe6d9",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${garamond.variable} ${instrumentSans.variable}`}>
      <body>
        {children}
        <ServiceWorkerRegister />
        <NewsNote />
      </body>
    </html>
  );
}
