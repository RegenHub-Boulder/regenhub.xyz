import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { createServiceClient } from "@/lib/supabase/admin";
import { markdownToEmailHtml } from "@/lib/newsletterMarkdown";

// Public, no auth — shareable. Renders any issue by key (draft or sent) so a
// draft link can be passed around in chat before it goes out. The /news index
// lists only sent issues; drafts are reachable only by direct link.
export const dynamic = "force-dynamic";

const cardFont = "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";

export async function generateMetadata({ params }: { params: Promise<{ key: string }> }): Promise<Metadata> {
  const { key } = await params;
  const admin = createServiceClient();
  const { data } = await admin.from("newsletter_issues").select("subject").eq("issue_key", key).maybeSingle();
  return { title: data?.subject ? `${data.subject} — RegenHub` : "RegenHub Dispatch" };
}

export default async function NewsIssuePage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const admin = createServiceClient();
  const { data: issue } = await admin
    .from("newsletter_issues")
    .select("issue_key, subject, markdown_body, status, created_at")
    .eq("issue_key", key)
    .maybeSingle();
  if (!issue || !issue.markdown_body) notFound();

  const dateLabel = issue.created_at
    ? new Date(issue.created_at).toLocaleDateString("en-US", { timeZone: "America/Denver", year: "numeric", month: "long", day: "numeric" })
    : "";
  const html = markdownToEmailHtml(issue.markdown_body);

  return (
    <main className="min-h-screen px-4 py-10">
      <article
        className="mx-auto max-w-[620px] rounded-xl bg-white shadow-lg p-8 sm:p-10"
        style={{ color: "#1a1a1a", fontFamily: cardFont, lineHeight: 1.6 }}
      >
        <p style={{ fontSize: 13, textTransform: "uppercase", letterSpacing: "0.08em", color: "#2d5e3e", margin: "0 0 2px" }}>
          RegenHub dispatch{issue.status === "draft" ? " · draft" : ""}
        </p>
        {dateLabel && <p style={{ fontSize: 13, color: "#888", margin: "0 0 8px" }}>{dateLabel}</p>}
        <div dangerouslySetInnerHTML={{ __html: html }} />
        <hr style={{ border: "none", borderTop: "1px solid #e5e5e5", margin: "28px 0 14px" }} />
        <p style={{ fontSize: 13, margin: 0 }}>
          <Link href="/news" style={{ color: "#2d5e3e" }}>← All dispatches</Link>
          {"  ·  "}
          <a href="https://regenhub.xyz/freeday" style={{ color: "#2d5e3e" }}>Grab a free day pass</a>
        </p>
      </article>
    </main>
  );
}
