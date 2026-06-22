import type { Metadata } from "next";
import { createServiceClient } from "@/lib/supabase/admin";
import { NewsletterStudio } from "@/components/admin/NewsletterStudio";

export const metadata: Metadata = { title: "Newsletter — Admin" };

/**
 * Newsletter studio. Drafts are authored in Markdown (by an admin or by Claude
 * via the newsletter skill), previewed as the real email, then sent
 * transparently with per-recipient tracking. The /admin layout gates access to
 * admins; newsletter_issues isn't in the generated Database types yet, so we read
 * via the untyped service client (consistent with the newsletter API routes).
 */
export default async function NewsletterPage() {
  const supabase = createServiceClient();
  const { data: draft } = await supabase
    .from("newsletter_issues")
    .select("id, issue_key, subject, markdown_body, status")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-2xl font-bold text-forest">Newsletter</h1>
        <p className="text-muted text-sm mt-1">
          Draft in Markdown (you or Claude), preview the real email, then send —
          with per-recipient tracking, automatic retries, and rate-limit back-off
          so you can see every one land.
        </p>
      </div>
      <NewsletterStudio initialDraft={draft ?? null} />
    </div>
  );
}
