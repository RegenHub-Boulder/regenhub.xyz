import { notFound } from "next/navigation";
import { techneConfig } from "@/lib/techne/config";
import { OldStewardPage } from "@/components/portal/legacy/OldStewardPage";
import { currentViewAs } from "@/lib/viewAsServer";
import { NotInPreview } from "@/components/portal/ViewAsBar";

export const metadata = { title: "Manage Events (old) — RegenHub" };
export const dynamic = "force-dynamic";

/**
 * "Old steward page": the regenOS-lane Manage Events, kept reachable while "Sign in with Techne" is on,
 * until Aaron retires it (components/portal/legacy/). With the Techne door off, /portal/events is this
 * page already, so this address is a 404 then. OldStewardPage itself 404s while the regenOS lane is off.
 */
export default async function OldManageEventsPage() {
  // An admin's portal preview (lib/viewAs.ts) shows only the member home: this page would read (and here and there
  // act on) the admin's own account, so it stops before any of that.
  if (await currentViewAs()) return <NotInPreview />;
  if (!techneConfig()) notFound();
  return <OldStewardPage />;
}
