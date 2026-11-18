import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { techneConfig } from "@/lib/techne/config";
import { TechneLinkConfirm } from "@/components/auth/TechneLinkConfirm";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Link your Techne account — RegenHub",
  robots: { index: false, follow: false },
};

/** Where the one door's link email lands. Door off or no code: the sign-in page. */
export default async function TechneLinkPage({ searchParams }: { searchParams: Promise<{ code?: string }> }) {
  const config = techneConfig();
  const { code } = await searchParams;
  if (!config || !code || !/^[A-Za-z0-9_-]{20,100}$/.test(code)) redirect("/auth/login");
  return (
    <div className="min-h-[60vh] flex items-center justify-center px-6">
      <div className="w-full max-w-md">
        <div className="glass-panel-strong p-8">
          <h1 className="text-2xl font-bold text-forest mb-6 text-center">Link your Techne account</h1>
          <TechneLinkConfirm config={config} code={code} />
        </div>
      </div>
    </div>
  );
}
