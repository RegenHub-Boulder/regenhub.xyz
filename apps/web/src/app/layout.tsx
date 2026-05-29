import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
// Validates required env vars at app boot — see lib/env.ts
import "@/lib/env";
import { ServiceWorkerRegister } from "@/components/pwa/ServiceWorkerRegister";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "RegenHub Boulder",
  description: "Boulder's regenerative cooperative workspace — community, economic democracy, and regenerative technology.",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "RegenHub",
  },
  openGraph: {
    title: "RegenHub Boulder",
    description: "A regenerative innovation hub in Boulder, CO",
    siteName: "RegenHub",
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
