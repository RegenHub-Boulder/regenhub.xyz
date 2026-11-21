import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { createServiceClient } from "@/lib/supabase/admin";
import { markdownToEmailHtml } from "@/lib/newsletterMarkdown";
import { normalizeAudience, withAudienceColumn } from "@/lib/newsletter";

// Public, no auth — shareable. Renders any issue by key (draft or sent) so a
// draft link can be passed around in chat before it goes out. The /news index
// lists only sent issues; drafts are reachable only by direct link.
export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ key: string }> }): Promise<Metadata> {
  const { key } = await params;
  const admin = createServiceClient();
  const { data } = await withAudienceColumn((col) =>
    admin.from("newsletter_issues").select(col ? "subject, audience" : "subject").eq("issue_key", key).maybeSingle());
  const row = data as { subject: string | null; audience?: string } | null;
  if (row && normalizeAudience(row.audience) !== "public") return { title: "RegenHub Dispatch" };
  return { title: row?.subject ? `${row.subject} — RegenHub` : "RegenHub Dispatch" };
}

export default async function NewsIssuePage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const admin = createServiceClient();
  const { data } = await withAudienceColumn((col) => admin
    .from("newsletter_issues")
    .select(`issue_key, subject, markdown_body, status, created_at${col ? ", audience" : ""}`)
    .eq("issue_key", key)
    .maybeSingle());
  const issue = data as { issue_key: string; subject: string; markdown_body: string | null; status: string; created_at: string | null; audience?: string } | null;
  // Members-only issues are never public: the same 404 as an unknown key. (Before 067 every issue is public.)
  if (!issue || !issue.markdown_body || normalizeAudience(issue.audience) !== "public") notFound();

  const dateLabel = issue.created_at
    ? new Date(issue.created_at).toLocaleDateString("en-US", { timeZone: "America/Denver", year: "numeric", month: "long", day: "numeric" })
    : "";
  const html = markdownToEmailHtml(issue.markdown_body);

  return (
    <div className="px-6 py-10">
      <article className="mx-auto max-w-[40rem] [&_a]:text-sage">
        <p className="text-sm italic text-sage mb-0.5">
          RegenHub dispatch{issue.status === "draft" ? " · draft" : ""}
        </p>
        {dateLabel && <p className="text-sm text-muted mb-2">{dateLabel}</p>}
        <div dangerouslySetInnerHTML={{ __html: html }} />
        <hr className="mt-8 mb-4 border-rule" />
        <p className="text-sm">
          <Link href="/news">← All dispatches</Link>
          {"  ·  "}
          <a href="https://regenhub.xyz/freeday">Grab a free day pass</a>
        </p>
      </article>
    </div>
  );
}
