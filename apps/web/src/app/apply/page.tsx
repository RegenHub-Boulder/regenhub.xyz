import type { Metadata } from "next";
import { redirect } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";
import { namedVoucher } from "@/lib/vouchers";
import { Card, CardContent } from "@/components/ui/card";
import { LoginForm } from "@/components/auth/LoginForm";
import { TechneDoor } from "@/components/auth/TechneDoor";
import ApplyForm from "./ApplyForm";
import regenHubFull from "@/assets/regenhub-full.svg";
import { isSyntheticEmail } from "@/lib/regenos/syntheticEmail";
import { techneConfig } from "@/lib/techne/config";

export const metadata: Metadata = {
  title: "Apply to join — RegenHub",
  description:
    "Apply to join RegenHub Boulder in a minute. A member who knows you vouches, we approve, and you pick a day plan. We reply within a day.",
};

export default async function ApplyPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  // Applications require sign-in so they link to the applicant's account
  // immediately (email + supabase_user_id) — no parallel identity, and existing
  // free-day/member folks upgrade against their real record. The magic link
  // creates an account for brand-new people too, then returns them here.
  if (!user) {
    const config = techneConfig();
    return (
      <div className="px-6 py-12">
        <div className="max-w-md mx-auto space-y-8">
          <div className="text-center">
            <Link href="/">
              <Image src={regenHubFull} alt="RegenHub" height={80} className="h-20 w-auto mx-auto mb-6 hover:opacity-80 transition-opacity" />
            </Link>
            <h1 className="text-3xl md:text-4xl font-bold text-forest mb-3">Apply to join</h1>
            <p className="text-muted max-w-sm mx-auto">
              Sign in first so your application links to your account.
              {!config && " We'll email you a magic link and bring you right back here."}
            </p>
          </div>

          <Card className="glass-panel">
            <CardContent className="p-8">
              {config ? (
                // The one door, as on /auth/login: a member signs straight in; anyone else applies with an
                // email link (an application needs an email we can reach).
                <TechneDoor next="/apply" mode="apply" />
              ) : (
                <LoginForm next="/apply" />
              )}
            </CardContent>
          </Card>

          <p className="text-center text-xs text-muted">
            Want to try it first?{" "}
            <Link href="/freeday" className="text-sage hover:underline">
              Claim a free day visit →
            </Link>
          </p>
        </div>
      </div>
    );
  }

  // Prefill from the applicant's account so they don't retype what we already know: their name from their member
  // record, and, if they've applied before, their answers (this form edits that application).
  const [{ data: member }, { data: application }] = await Promise.all([
    supabase.from("members").select("name, telegram_username").eq("supabase_user_id", user.id).maybeSingle(),
    supabase.from("applications").select("*").eq("supabase_user_id", user.id).maybeSingle(),
  ]);
  const app = application as { name?: string; about?: string | null; how_found?: string | null; telegram?: string | null; known_by_member_id?: number | null; status?: string } | null;
  // Approved already: nothing to apply for; the portal is where they pick a plan.
  if (app?.status === "approved") redirect("/portal");
  let knownBy: { id: number; name: string } | null = null;
  if (app?.known_by_member_id) knownBy = await namedVoucher(createServiceClient(), app.known_by_member_id, user.id);

  const initial = {
    name: app?.name ?? member?.name ?? "",
    about: app?.about ?? "",
    how_found: app?.how_found ?? "",
    telegram: app?.telegram ?? member?.telegram_username ?? "",
    knownBy,
  };

  return (
    <>
      <ApplyForm
        authenticatedEmail={user.email && !isSyntheticEmail(user.email) ? user.email : ""}
        initial={initial}
      />
      <div className="px-6 pb-12 -mt-4">
        <p className="text-center text-xs text-muted max-w-md mx-auto">
          Want to try it first?{" "}
          <Link href="/freeday" className="text-sage hover:underline">
            Claim a free day visit →
          </Link>
        </p>
      </div>
    </>
  );
}
