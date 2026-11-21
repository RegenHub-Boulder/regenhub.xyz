import { redirect } from "next/navigation";

export default function ClaimsRedirect() {
  redirect("/admin/people?tab=freedays");
}
