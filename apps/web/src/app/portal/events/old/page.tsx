import { notFound } from "next/navigation";
import { techneConfig } from "@/lib/techne/config";
import { OldStewardPage } from "@/components/portal/legacy/OldStewardPage";

export const metadata = { title: "Manage Events (old) — RegenHub" };
export const dynamic = "force-dynamic";

/**
 * "Old steward page": the regenOS-lane Manage Events, kept reachable while "Sign in with Techne" is on,
 * until Aaron retires it (components/portal/legacy/). With the Techne door off, /portal/events is this
 * page already, so this address is a 404 then. OldStewardPage itself 404s while the regenOS lane is off.
 */
export default async function OldManageEventsPage() {
  if (!techneConfig()) notFound();
  return <OldStewardPage />;
}
