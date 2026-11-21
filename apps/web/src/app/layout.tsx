import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "@rainbow-me/rainbowkit/styles.css";
import "./globals.css";
// STAGING ONLY (T-482): every rule is scoped to html[data-style], which production never sets.
import "./style-directions.css";
// Validates required env vars at app boot — see lib/env.ts
import "@/lib/env";
import { ServiceWorkerRegister } from "@/components/pwa/ServiceWorkerRegister";
import { NewsNote } from "@/components/techne/NewsNote";
import { OG_IMAGES, SITE_DESCRIPTION, siteUrl } from "@/lib/metadata";
import { isStylePreviewEnabled, STYLE_FONTS_HREF, stylePreviewScript } from "@/lib/stylePreview";

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
  // STAGING ONLY (T-482): the visual-direction switch. Off (the default, and always on regenhub.xyz) renders
  // exactly what it did before: no script, no font link, no attribute.
  const stylePreview = isStylePreviewEnabled();
  return (
    <html lang="en" suppressHydrationWarning={stylePreview || undefined}>
      {stylePreview && (
        <head>
          <script dangerouslySetInnerHTML={{ __html: stylePreviewScript() }} />
          <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
          <link rel="stylesheet" href={STYLE_FONTS_HREF} />
        </head>
      )}
      <body className={inter.className}>
        {children}
        <ServiceWorkerRegister />
        <NewsNote />
      </body>
    </html>
  );
}
