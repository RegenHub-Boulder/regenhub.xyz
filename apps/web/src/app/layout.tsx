import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "@rainbow-me/rainbowkit/styles.css";
import "./globals.css";
// Validates required env vars at app boot — see lib/env.ts
import "@/lib/env";
import { ServiceWorkerRegister } from "@/components/pwa/ServiceWorkerRegister";
import { OG_IMAGES, SITE_DESCRIPTION, siteUrl } from "@/lib/metadata";

const inter = Inter({ subsets: ["latin"] });

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
  themeColor: "#2d5e3e",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className={inter.className}>
        {children}
        <ServiceWorkerRegister />
      </body>
    </html>
  );
}
