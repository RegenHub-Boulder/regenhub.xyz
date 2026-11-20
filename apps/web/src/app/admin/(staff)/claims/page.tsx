import { redirect } from "next/navigation";

export default function ClaimsRedirect() {
  redirect("/admin/pipeline?tab=freedays");
}
