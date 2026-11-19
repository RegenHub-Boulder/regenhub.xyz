import { redirect } from "next/navigation";

export default function LockRedirect() {
  redirect("/admin/access?tab=sync");
}
