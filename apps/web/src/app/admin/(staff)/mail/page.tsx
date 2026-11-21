import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/admin";
import type { Metadata } from "next";
import { createServiceClient } from "@/lib/supabase/admin";
import { withAudienceColumn } from "@/lib/newsletter";
import { NewsletterManager, type Issue as NewsletterIssue } from "@/components/admin/NewsletterManager";
import { CommunicationsComposer } from "@/components/admin/CommunicationsComposer";
import { AdminTabs } from "@/components/admin/AdminTabs";

export const metadata: Metadata = { title: "Mail — Admin" };
export const dynamic = "force-dynamic";

type MailTab = "newsletter" | "group";

/**
 * Mail: the one place for email to many people. The Newsletter tab is the studio (every issue, drafts and sent,
 * composed in Markdown by an admin or by Claude via the newsletter skill, previewed as the real email, sent with
 * per-recipient tracking). "Send to a group" is the targeted email to members picked by filter (was "Comms").
 * newsletter_issues isn't in the generated Database types yet, so it's read via the untyped service client after
 * the admin check (consistent with the newsletter API routes).
 */
export default async function MailPage() {
  if (!await requireAdmin()) redirect("/portal");
  const supabase = createServiceClient();
  const { data: issues } = await withAudienceColumn((col) => supabase
    .from("newsletter_issues")
    .select(`id, issue_key, subject, markdown_body, status, created_at, updated_at, recipients_count, sent_count${col ? ", audience" : ""}`)
    .order("updated_at", { ascending: false }));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-forest">Mail</h1>
        <p className="text-muted text-sm mt-1">
          The newsletter, and email to a group of members. Sent issues appear on{" "}
          <a href="/news" className="text-sage hover:underline" target="_blank" rel="noopener noreferrer">regenhub.xyz/news</a>.
        </p>
      </div>
      <AdminTabs<MailTab>
        tabs={[
          { key: "newsletter", label: "Newsletter" },
          { key: "group", label: "Send to a group" },
        ]}
      >
        {{
          newsletter: <NewsletterManager initialIssues={(issues ?? []) as unknown as NewsletterIssue[]} />,
          group: (
            <div className="max-w-3xl">
              <CommunicationsComposer />
            </div>
          ),
        }}
      </AdminTabs>
    </div>
  );
}
