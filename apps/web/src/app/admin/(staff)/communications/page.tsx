import { redirect } from "next/navigation";

/** "Comms" became Mail's "Send to a group" tab; its old newsletter note and auto-send were retired (T-482). */
export default function CommunicationsRedirect() {
  redirect("/admin/mail?tab=group");
}
