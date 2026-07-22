import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { Card, CardContent } from "@/components/ui/card";
import { RegenerateCodeButton } from "@/components/portal/RegenerateCodeButton";
import { RevealPin } from "@/components/portal/RevealPin";
import { Button } from "@/components/ui/button";
import { Key, Nfc, AlertCircle, Zap, Ticket } from "lucide-react";

export const metadata = { title: "My Door Code — RegenHub" };

export default async function MyCodePage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const { data: member } = await supabase
    .from("members")
    .select("id, name, pin_code, pin_code_slot, nfc_key_address, member_type")
    .eq("supabase_user_id", user.id)
    .single();

  if (!member) {
    // Authenticated but no member row linked yet — usually means the email on
    // their auth user hasn't been reconciled with an existing member record.
    return (
      <div className="glass-panel p-8 text-center max-w-md mx-auto mt-8">
        <AlertCircle className="w-8 h-8 text-amber-400 mx-auto mb-3" />
        <h2 className="font-semibold mb-2">Account not linked yet</h2>
        <p className="text-sm text-muted mb-5">
          We didn&apos;t find a member record for this sign-in. If you have an existing
          account, head to your portal to link it; otherwise apply to join.
        </p>
        <div className="flex gap-2 justify-center flex-wrap">
          <Link href="/portal">
            <Button className="btn-glass">Go to portal</Button>
          </Link>
          <Link href="/apply">
            <Button className="btn-primary-glass">Apply to join</Button>
          </Link>
        </div>
      </div>
    );
  }

  if (member.member_type === "day_pass") {
    return (
      <div className="glass-panel p-8 text-center max-w-md mx-auto mt-8">
        <AlertCircle className="w-8 h-8 text-muted mx-auto mb-3" />
        <h2 className="font-semibold mb-2">Permanent codes are for Full Members</h2>
        <p className="text-sm text-muted mb-5">
          You&apos;re on a day-pass plan, so you generate a fresh code for each visit on the Passes page.
        </p>
        <Link href="/portal/passes">
          <Button className="btn-primary-glass gap-2">
            <Ticket className="w-4 h-4" />
            Go to Day Passes
          </Button>
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-8 max-w-2xl">
      <div>
        <h1 className="text-3xl font-bold text-forest">My Door Code</h1>
        <p className="text-muted mt-1">Your permanent PIN for the RegenHub smart lock</p>
      </div>

      <Card className="glass-panel">
        <CardContent className="p-8">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <Key className="w-5 h-5 text-sage" />
                <span className="text-sm text-muted">Current PIN</span>
              </div>
              {member.pin_code ? (
                <RevealPin code={member.pin_code} slot={member.pin_code_slot} />
              ) : (
                <p className="text-muted text-sm mt-2">No code assigned yet. Generate one below.</p>
              )}
            </div>
            <RegenerateCodeButton
              memberId={member.id}
              hasSlot={!!member.pin_code_slot}
            />
          </div>
        </CardContent>
      </Card>

      {member.nfc_key_address && (
        <Card className="glass-panel">
          <CardContent className="p-6">
            <div className="flex items-center gap-2 mb-2">
              <Nfc className="w-5 h-5 text-sage" />
              <span className="text-sm font-medium">NFC Key</span>
            </div>
            <p className="text-xs font-mono text-muted break-all">{member.nfc_key_address}</p>
          </CardContent>
        </Card>
      )}

      <Link
        href="/portal/passes"
        className="glass-panel p-5 flex items-center gap-4 hover:bg-white/5 transition-colors group"
      >
        <Zap className="w-5 h-5 text-gold shrink-0" />
        <div>
          <p className="font-medium text-sm">Generate a live code for a guest</p>
          <p className="text-xs text-muted mt-0.5">Temporary codes with custom expiry — 4 hours to 1 week</p>
        </div>
        <span className="ml-auto text-muted group-hover:text-foreground text-sm">Live Codes →</span>
      </Link>

      <div className="glass-panel p-6 space-y-3">
        <h3 className="font-semibold">How to use the keypad</h3>
        <ol className="text-sm text-muted space-y-2 list-decimal list-inside">
          <li>Approach either 2nd-floor keypad — front or back door</li>
          <li>Enter your PIN followed by the # key</li>
          <li>Wait for the green LED and click sound</li>
          <li>Pull the door handle within 5 seconds</li>
        </ol>
      </div>
    </div>
  );
}
