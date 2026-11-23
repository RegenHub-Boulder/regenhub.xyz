import { redirect } from "next/navigation";
import { techneConfig } from "@/lib/techne/config";
import { STEWARD_PATH } from "@/lib/techne/session";
import { OldStewardPage } from "@/components/portal/legacy/OldStewardPage";
import { currentViewAs } from "@/lib/viewAsServer";
import { NotInPreview } from "@/components/portal/ViewAsBar";

export const metadata = { title: "Manage Events — RegenHub" };

/**
 * Manage Events. With TECHNE_SIGNIN_ENABLED off this is the old regenOS-lane page, unchanged
 * (components/portal/legacy/OldStewardPage.tsx). With it on, the stewards' page is /admin/events (Roles
 * included): it answers to the Techne role in RegenHub, not a site membership, so a Techne steward who
 * isn't a member can reach it (the portal frame needs a member session). Old links land there.
 */
export default async function ManageEventsPage() {
  // An admin's portal preview (lib/viewAs.ts) shows only the member home: this page would read (and here and there
  // act on) the admin's own account, so it stops before any of that.
  if (await currentViewAs()) return <NotInPreview />;
  if (!techneConfig()) return <OldStewardPage />;
  redirect(STEWARD_PATH);
}
