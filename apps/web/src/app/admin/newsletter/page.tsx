import type { Metadata } from "next";
import { createServiceClient } from "@/lib/supabase/admin";
import { NewsletterManager } from "@/components/admin/NewsletterManager";

export const metadata: Metadata = { title: "Newsletter — Admin" };
export const dynamic = "force-dynamic";

/**
 * Newsletter studio. Lists every issue (drafts + sent) on the left; the editor
 * on the right composes/sends the selected one or a fresh draft. Drafts are
 * authored in Markdown (by an admin or by Claude via the newsletter skill),
 * previewed as the real email, then sent transparently with per-recipient
 * tracking. The /admin layout gates access to admins; newsletter_issues isn't in
 * the generated Database types yet, so we read via the untyped service client
 * (consistent with the newsletter API routes).
 */
export default async function NewsletterPage() {
  const supabase = createServiceClient();
  const { data: issues } = await supabase
    .from("newsletter_issues")
    .select("id, issue_key, subject, markdown_body, status, created_at, updated_at, recipients_count, sent_count")
    .order("updated_at", { ascending: false });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-forest">Newsletter</h1>
        <p className="text-muted text-sm mt-1">
          Draft in Markdown (you or Claude), preview the real email, then send —
          with per-recipient tracking, automatic retries, and rate-limit back-off
          so you can see every one land. Sent issues are published to{" "}
          <a href="/news" className="text-sage hover:underline" target="_blank" rel="noopener noreferrer">regenhub.xyz/news</a>.
        </p>
      </div>
      <NewsletterManager initialIssues={issues ?? []} />
    </div>
  );
}
