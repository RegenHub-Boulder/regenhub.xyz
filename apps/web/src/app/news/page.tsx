import type { Metadata } from "next";
import Link from "next/link";
import { createServiceClient } from "@/lib/supabase/admin";
import { withAudienceColumn } from "@/lib/newsletter";

// Public archive of sent dispatches.
export const metadata: Metadata = { title: "Dispatches — RegenHub" };
export const dynamic = "force-dynamic";

interface IssueRow {
  issue_key: string;
  subject: string;
  created_at: string | null;
}

export default async function NewsIndexPage() {
  const admin = createServiceClient();
  // Before migration 067 there is no audience column and every issue is public.
  const { data } = await withAudienceColumn((col) => {
    const q = admin.from("newsletter_issues").select("issue_key, subject, created_at").eq("status", "sent");
    return (col ? q.eq("audience", "public") : q).order("created_at", { ascending: false });
  });
  const issues = (data ?? []) as IssueRow[];

  return (
    <div className="px-6 py-10">
      <div className="mx-auto max-w-[40rem]">
        <p className="text-sm italic text-sage mb-1">
          RegenHub
        </p>
        <h1 className="text-[2rem] leading-tight mb-2">Dispatches</h1>
        <p className="text-muted">
          Notes from the cooperative — what we&rsquo;ve been exploring, who&rsquo;s
          visited, and what&rsquo;s coming up.
        </p>

        {issues.length === 0 ? (
          <p className="mt-6 text-muted">No dispatches yet — the first one is on its way.</p>
        ) : (
          <ul className="mt-6 border-b border-rule">
            {issues.map((i) => (
              <li key={i.issue_key} className="py-3 border-t border-rule">
                <Link href={`/news/${i.issue_key}`} className="text-lg text-foreground hover:text-sage transition-colors">
                  {i.subject}
                </Link>
                <div className="text-sm text-muted">
                  {i.created_at
                    ? new Date(i.created_at).toLocaleDateString("en-US", { timeZone: "America/Denver", month: "long", day: "numeric", year: "numeric" })
                    : ""}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
