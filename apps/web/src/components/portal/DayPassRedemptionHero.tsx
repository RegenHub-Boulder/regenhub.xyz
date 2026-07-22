import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Key, MapPin, Clock, ArrowRight, Sparkles } from "lucide-react";
import { createServiceClient } from "@/lib/supabase/admin";

interface Member {
  id: number;
  name: string;
  member_type: string;
  day_passes_balance: number;
}

interface Props {
  member: Member;
}

const KEYPAD_STEPS = [
  "Type your 6-digit code at either 2nd-floor keypad (front or back door)",
  "Press # to confirm",
  "Wait for the green LED and click sound",
  "Pull the door handle within 5 seconds",
];

function formatRemaining(expiresIso: string, nowMs: number): string {
  const ms = new Date(expiresIso).getTime() - nowMs;
  if (ms <= 0) return "expired";
  const hours = Math.floor(ms / 3_600_000);
  const mins = Math.floor((ms % 3_600_000) / 60_000);
  if (hours >= 1) return `${hours}h ${mins}m left`;
  return `${mins}m left`;
}

/**
 * The "what visitors actually came here to do" hero, shown at the top of /portal
 * for day-pass members. Two states:
 *
 *   1) Active code right now → show the 6-digit code huge, countdown to expiry,
 *      keypad steps inline. This is what a member sees when they're standing at
 *      the door with a poor cell connection.
 *
 *   2) Balance > 0, no active code → big "Get your door code" CTA pointing at
 *      /portal/passes where the generate flow lives.
 *
 * Returns null for Full members (they have a permanent code) and for day-pass
 * members with no balance + no active code (they need to buy or get approved).
 */
export async function DayPassRedemptionHero({ member }: Props) {
  if (member.member_type !== "day_pass") return null;

  const admin = createServiceClient();
  /* eslint-disable react-hooks/purity -- server component, renders once per request */
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  /* eslint-enable react-hooks/purity */
  const { data: activeCode } = await admin
    .from("day_codes")
    .select("code, pin_slot, expires_at, label")
    .eq("member_id", member.id)
    .eq("is_active", true)
    .gt("expires_at", nowIso)
    .order("expires_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  // No active code AND no balance → nothing actionable here; the regular
  // upgrade prompts elsewhere on the page handle this case.
  if (!activeCode && member.day_passes_balance === 0) return null;

  if (activeCode) {
    return (
      <Card className="glass-panel-strong border border-gold/40 bg-gold/[0.05]">
        <CardContent className="p-6 sm:p-8">
          <div className="flex items-center gap-2 mb-3">
            <Sparkles className="w-4 h-4 text-gold" />
            <span className="text-xs uppercase tracking-wider text-gold font-medium">
              Your door code
            </span>
            <span className="text-xs text-muted ml-auto">{formatRemaining(activeCode.expires_at, nowMs)}</span>
          </div>
          <p className="text-5xl sm:text-6xl font-bold text-foreground font-mono tracking-wider tabular-nums text-center my-4 select-all">
            {activeCode.code}
          </p>
          <p className="text-xs text-muted text-center mb-5">
            Valid until 6 PM today. Use at the front-door keypad.
          </p>

          <div className="grid sm:grid-cols-3 gap-3 text-xs text-muted border-t border-white/5 pt-4">
            <div className="flex items-start gap-2">
              <Key className="w-4 h-4 text-sage shrink-0 mt-0.5" />
              <div>
                <p className="text-foreground font-medium">How to enter</p>
                <ol className="list-decimal list-inside mt-1 space-y-0.5">
                  {KEYPAD_STEPS.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ol>
              </div>
            </div>
            <div className="flex items-start gap-2">
              <MapPin className="w-4 h-4 text-sage shrink-0 mt-0.5" />
              <div>
                <p className="text-foreground font-medium">Address</p>
                <p className="mt-1">1515 Walnut St<br />Suite 200<br />Boulder, CO</p>
              </div>
            </div>
            <div className="flex items-start gap-2">
              <Clock className="w-4 h-4 text-sage shrink-0 mt-0.5" />
              <div>
                <p className="text-foreground font-medium">Hours</p>
                <p className="mt-1">Mon–Fri<br />8 AM – 6 PM</p>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  // Balance > 0, no active code → show the "Get code" CTA.
  return (
    <Card className="glass-panel border border-gold/30 bg-gold/[0.03]">
      <CardContent className="p-6 sm:p-7">
        <div className="flex items-start gap-4 flex-wrap">
          <Key className="w-9 h-9 text-gold shrink-0" />
          <div className="flex-1 min-w-0">
            <h2 className="text-xl font-semibold mb-1">
              Your day pass is ready
            </h2>
            <p className="text-sm text-muted mb-3">
              {member.day_passes_balance === 1
                ? "You have 1 day pass."
                : `You have ${member.day_passes_balance} day passes.`}{" "}
              Generate a 6-digit code below — it stays valid until 6 PM today and works at the front-door keypad.
            </p>
            <Link href="/portal/passes">
              <Button className="btn-primary-glass gap-2">
                Generate code <ArrowRight className="w-4 h-4" />
              </Button>
            </Link>
          </div>
        </div>

        <div className="grid sm:grid-cols-2 gap-3 text-xs text-muted border-t border-white/5 pt-4 mt-5">
          <div className="flex items-start gap-2">
            <MapPin className="w-4 h-4 text-sage shrink-0 mt-0.5" />
            <p>1515 Walnut St, Suite 200, Boulder, CO — 2nd floor</p>
          </div>
          <div className="flex items-start gap-2">
            <Clock className="w-4 h-4 text-sage shrink-0 mt-0.5" />
            <p>Monday–Friday, 8 AM – 6 PM</p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
