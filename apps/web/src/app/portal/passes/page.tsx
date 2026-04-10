import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { RequestDayPassButton } from "@/components/portal/RequestDayPassButton";
import { RevokeCodeButton } from "@/components/portal/RevokeCodeButton";
import { Ticket, Clock, ShoppingCart, Key, Mail } from "lucide-react";
import { Button } from "@/components/ui/button";

export const metadata = { title: "Live Codes — RegenHub" };

export default async function PassesPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const { data: member } = await supabase
    .from("members")
    .select("id, name, email, member_type, day_passes_balance")
    .eq("supabase_user_id", user.id)
    .single();

  if (!member) {
    return (
      <div className="glass-panel p-8 text-center max-w-md mx-auto mt-16">
        <Ticket className="w-8 h-8 text-muted mx-auto mb-3" />
        <h2 className="text-xl font-semibold mb-2">Account Not Found</h2>
        <p className="text-muted text-sm">
          Your login isn&apos;t linked to a member profile yet. Contact an admin to get set up.
        </p>
      </div>
    );
  }

  // Build Stripe payment link URLs with member context pre-filled
  const stripeParams = `?client_reference_id=${member.id}&prefilled_email=${encodeURIComponent(member.email ?? "")}`;
  const daypassUrl = process.env.NEXT_PUBLIC_STRIPE_DAYPASS_LINK
    ? `${process.env.NEXT_PUBLIC_STRIPE_DAYPASS_LINK}${stripeParams}`
    : null;
  const fivepackUrl = process.env.NEXT_PUBLIC_STRIPE_FIVEPACK_LINK
    ? `${process.env.NEXT_PUBLIC_STRIPE_FIVEPACK_LINK}${stripeParams}`
    : null;

  const isFullMember = member.member_type !== "day_pass";

  const { data: activeCodes } = await supabase
    .from("day_codes")
    .select("*")
    .eq("member_id", member.id)
    .eq("is_active", true)
    .order("expires_at", { ascending: true, nullsFirst: false });

  const hasStripe = !!(daypassUrl || fivepackUrl);

  return (
    <div className="space-y-8 max-w-3xl">
      <div>
        <h1 className="text-3xl font-bold text-forest">
          {isFullMember ? "Guest Day Passes" : "Day Passes"}
        </h1>
        <p className="text-muted mt-1">
          {isFullMember
            ? "Generate temporary door codes for guests"
            : "Get a door code for the day (8 AM \u2013 6 PM, Mon\u2013Fri)"}
        </p>
      </div>

      {/* Balance + action */}
      <Card className="glass-panel">
        <CardContent className="p-6">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div>
              <div className="flex items-center gap-2 text-sm text-muted mb-1">
                <Ticket className="w-4 h-4" />
                Passes remaining
              </div>
              <p className={`text-4xl font-bold ${member.day_passes_balance > 0 ? "text-gold" : "text-muted"}`}>
                {member.day_passes_balance}
              </p>
            </div>
            <RequestDayPassButton
              memberId={member.id}
              isFullMember={isFullMember}
              remainingUses={member.day_passes_balance}
            />
          </div>
          {member.day_passes_balance === 0 && (
            <p className="text-sm text-muted mt-4">
              {hasStripe
                ? "No passes remaining \u2014 grab one below to get a door code."
                : "No passes remaining \u2014 day pass purchasing will be available soon."}
            </p>
          )}
        </CardContent>
      </Card>

      {/* Active codes */}
      {activeCodes && activeCodes.length > 0 && (
        <div>
          <h2 className="text-lg font-semibold mb-4">Active codes</h2>
          <div className="space-y-3">
            {activeCodes.map((code) => {
              const expiresAt = code.expires_at ? new Date(code.expires_at) : null;
              // eslint-disable-next-line react-hooks/purity -- server component, renders once
              const msLeft = expiresAt ? expiresAt.getTime() - Date.now() : null;
              const hoursLeft = msLeft != null ? Math.max(0, Math.ceil(msLeft / 3600000)) : null;
              const timeLabel = hoursLeft == null
                ? null
                : hoursLeft < 24 ? `${hoursLeft}h left` : `${Math.ceil(hoursLeft / 24)}d left`;

              return (
                <div key={code.id} className="glass-panel p-4 flex items-center justify-between gap-4">
                  <div>
                    <p className="font-mono font-bold text-gold text-xl">{code.code}</p>
                    {code.label && <p className="text-xs text-muted mt-0.5">{code.label}</p>}
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="flex items-center gap-2 text-sm text-muted">
                      <Clock className="w-4 h-4" />
                      {timeLabel != null ? (
                        <>
                          <span>{timeLabel}</span>
                          <Badge variant="outline" className="text-xs border-white/20">
                            {expiresAt!.toLocaleDateString("en-US", {
                              month: "short", day: "numeric",
                              timeZone: "America/Denver",
                            })}
                          </Badge>
                        </>
                      ) : (
                        <span>No expiry</span>
                      )}
                    </div>
                    <RevokeCodeButton codeId={code.id} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {(!activeCodes || activeCodes.length === 0) && (
        <div className="glass-panel p-8 text-center text-muted">
          <Ticket className="w-8 h-8 mx-auto mb-3 opacity-40" />
          <p>No active codes. Generate one above.</p>
        </div>
      )}

      {/* Buy more passes */}
      {(daypassUrl || fivepackUrl) && (
        <div>
          <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
            <ShoppingCart className="w-5 h-5 text-sage" />
            {isFullMember ? "Buy guest passes" : "Get day passes"}
          </h2>
          <div className="grid sm:grid-cols-2 gap-4">
            {daypassUrl && (
              <a
                href={daypassUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="glass-panel p-5 hover:bg-white/5 transition-colors group block"
              >
                <p className="font-semibold mb-1">Single Day Pass</p>
                <p className="text-3xl font-bold text-gold mb-3">$25</p>
                <p className="text-xs text-muted group-hover:text-foreground transition-colors">
                  1 door code &rarr; full day access &rarr;
                </p>
              </a>
            )}
            {fivepackUrl && (
              <a
                href={fivepackUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="glass-panel p-5 hover:bg-white/5 transition-colors group block"
              >
                <div className="flex items-start justify-between">
                  <p className="font-semibold mb-1">5-Pack</p>
                  <span className="text-xs bg-sage/20 text-sage px-2 py-0.5 rounded-full">Save $25</span>
                </div>
                <p className="text-3xl font-bold text-gold mb-3">$100</p>
                <p className="text-xs text-muted group-hover:text-foreground transition-colors">
                  5 door codes &rarr; best value &rarr;
                </p>
              </a>
            )}
          </div>
        </div>
      )}

      {/* Membership upgrade prompt for day_pass members */}
      {!isFullMember && (
        <Card className="glass-panel border border-forest/20">
          <CardContent className="p-6">
            <div className="flex items-start gap-4">
              <Key className="w-7 h-7 text-sage shrink-0 mt-0.5" />
              <div className="flex-1">
                <h3 className="font-semibold mb-1">Ready for your own desk?</h3>
                <p className="text-sm text-muted mb-4">
                  Desk members get a permanent door code, 24/7 access, and a path to co-op ownership.
                  Desks are $250/month.
                </p>
                <a href="mailto:boulder.regenhub@gmail.com?subject=Interested in desk membership">
                  <Button className="btn-glass gap-2 text-sm">
                    <Mail className="w-4 h-4" />
                    Inquire about membership
                  </Button>
                </a>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
