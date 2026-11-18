import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { techneConfig } from "@/lib/techne/config";
import { currentTechne } from "@/lib/techne/webSession";
import { LINK_PATH } from "@/lib/techne/linkPath";
import { TechneLinkConfirm } from "@/components/auth/TechneLinkConfirm";
import { SignInWithTechne, SignOutOfTechne } from "@/components/techne/SignInWithTechne";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Link your Techne account — RegenHub",
  robots: { index: false, follow: false },
};

/** Where the one door's link email lands. Door off or no code: the sign-in page. */
export default async function TechneLinkPage({ searchParams }: { searchParams: Promise<{ code?: string }> }) {
  const { code } = await searchParams;
  if (!techneConfig() || !code || !/^[A-Za-z0-9_-]{20,100}$/.test(code)) redirect("/auth/login");
  const here = `${LINK_PATH}?code=${encodeURIComponent(code)}`;
  const who = await currentTechne();
  return (
    <div className="py-8 sm:min-h-[60vh] flex items-start sm:items-center justify-center px-6">
      <div className="w-full max-w-md">
        <div className="glass-panel-strong p-8">
          <h1 className="text-2xl font-bold text-forest mb-6 text-center">Link your Techne account</h1>
          <div className="space-y-5 text-center" data-testid="techne-link-confirm">
            {who ? (
              <>
                <p className="text-sm text-muted">
                  Link {who.handle ? <span className="text-forest font-medium">@{who.handle}</span> : "the Techne account you're signed in with"} to your
                  RegenHub membership. After this, &ldquo;Sign in with Techne&rdquo; opens your portal.
                </p>
                <TechneLinkConfirm code={code} />
                <div>
                  <SignOutOfTechne next={here} />
                </div>
              </>
            ) : (
              <>
                <p className="text-sm text-muted">Sign in with the Techne account you asked from to finish linking.</p>
                <SignInWithTechne next={here} />
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
