import { redirect } from "next/navigation";
import { rsvpConfig } from "@/lib/techne/rsvpConfig";
import { TechneCallback } from "@/components/events/TechneCallback";
import { PublicShell } from "@/components/layout/PublicShell";

/** Where "Sign in with Techne" comes back to: finish sign-in, then back to the event. */
export const dynamic = "force-dynamic";

export default function TechneCallbackPage() {
  const config = rsvpConfig();
  if (!config) redirect("/events");
  return (
    <PublicShell>
      <TechneCallback config={config} />
    </PublicShell>
  );
}
