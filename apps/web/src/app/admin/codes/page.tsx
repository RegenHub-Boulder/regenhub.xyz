import { redirect } from "next/navigation";

export default function CodesRedirect() {
  redirect("/admin/access?tab=codes");
}
