import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "RegenHub Boulder",
  description: "Boulder's regenerative cooperative workspace — community, economic democracy, and regenerative technology.",
  openGraph: {
    title: "RegenHub Boulder",
    description: "A regenerative innovation hub in Boulder, CO",
    siteName: "RegenHub",
  },
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
      </body>
    </html>
  );
}
