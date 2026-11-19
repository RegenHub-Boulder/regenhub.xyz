import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { loginUrlFor } from "@/lib/safeNext";
import { portalViewer } from "@/lib/admin";

/**
 * The portal admin pages (members, billing, access…): RegenHub admins only (`members.is_admin`, not disabled).
 * /admin/stewards sits outside this group: its authority is the Techne role, not this flag.
 */
export default async function StaffLayout({ children }: { children: React.ReactNode }) {
  const { user, isAdmin } = await portalViewer();
  if (!user) redirect(loginUrlFor((await headers()).get("x-pathname")));
  if (!isAdmin) redirect("/portal");
  return <>{children}</>;
}
