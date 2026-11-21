import { redirect } from "next/navigation";

/** The newsletter studio is the Newsletter tab of Mail. */
export default function NewsletterRedirect() {
  redirect("/admin/mail");
}
