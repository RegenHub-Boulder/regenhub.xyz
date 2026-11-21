import { redirect } from "next/navigation";

/** RegenHub's roles (stewards) live inside Events now (T-482): the Roles section, opened. */
export default function StewardsRedirect() {
  redirect("/admin/events?roles=open#roles");
}
