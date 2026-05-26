import { redirect } from "next/navigation";

export default function ApplicationsRedirect() {
  redirect("/admin/pipeline?tab=applications");
}
