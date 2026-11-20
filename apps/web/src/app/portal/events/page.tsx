import { redirect } from "next/navigation";
import { techneConfig } from "@/lib/techne/config";
import { STEWARD_PATH } from "@/lib/techne/session";
import { OldStewardPage } from "@/components/portal/legacy/OldStewardPage";

export const metadata = { title: "Manage Events — RegenHub" };

/**
 * Manage Events. With TECHNE_SIGNIN_ENABLED off this is the old regenOS-lane page, unchanged
 * (components/portal/legacy/OldStewardPage.tsx). With it on, the stewards' page is /admin/events, beside
 * /admin/stewards: it answers to the Techne role in RegenHub, not a site membership, so a Techne steward who
 * isn't a member can reach it (the portal frame needs a member session). Old links land there.
 */
export default async function ManageEventsPage() {
  if (!techneConfig()) return <OldStewardPage />;
  redirect(STEWARD_PATH);
}
