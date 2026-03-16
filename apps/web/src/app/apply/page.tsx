import { redirect } from "next/navigation";

// The free day page is now the primary entry point for everyone.
// Redirect /apply → /freeday so existing links still work.
export default function ApplyPage() {
  redirect("/freeday");
}
