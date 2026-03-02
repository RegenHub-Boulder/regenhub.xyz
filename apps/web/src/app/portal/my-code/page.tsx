import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Card, CardContent } from "@/components/ui/card";
import { RegenerateCodeButton } from "@/components/portal/RegenerateCodeButton";
import { Key, Nfc, AlertCircle } from "lucide-react";

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

  if (!member || member.member_type !== "full") {
    return (
      <div className="glass-panel p-8 text-center max-w-md mx-auto mt-8">
        <AlertCircle className="w-8 h-8 text-muted mx-auto mb-3" />
        <h2 className="font-semibold mb-2">Full membership required</h2>
        <p className="text-sm text-muted">Permanent door codes are for full members. Day pass members use the Passes page.</p>
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
                <p className="text-5xl font-mono font-bold text-gold tracking-widest mt-3">
                  {member.pin_code}
                </p>
              ) : (
                <p className="text-muted text-sm mt-2">No code assigned yet. Generate one below.</p>
              )}
              {member.pin_code_slot && (
                <p className="text-xs text-muted mt-3">Slot {member.pin_code_slot}</p>
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

      <div className="glass-panel p-6 space-y-3">
        <h3 className="font-semibold">How to use the keypad</h3>
        <ol className="text-sm text-muted space-y-2 list-decimal list-inside">
          <li>Approach the keypad by the front door</li>
          <li>Enter your PIN followed by the # key</li>
          <li>Wait for the green LED and click sound</li>
          <li>Pull the door handle within 5 seconds</li>
        </ol>
      </div>
    </div>
  );
}
