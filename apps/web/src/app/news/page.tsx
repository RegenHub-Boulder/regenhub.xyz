import type { Metadata } from "next";
import Link from "next/link";
import { createServiceClient } from "@/lib/supabase/admin";

// Public archive of sent dispatches.
export const metadata: Metadata = { title: "Dispatches — RegenHub" };
export const dynamic = "force-dynamic";

const cardFont = "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";

interface IssueRow {
  issue_key: string;
  subject: string;
  created_at: string | null;
}

export default async function NewsIndexPage() {
  const admin = createServiceClient();
  const { data } = await admin
    .from("newsletter_issues")
    .select("issue_key, subject, created_at")
    .eq("status", "sent")
    .order("created_at", { ascending: false });
  const issues = (data ?? []) as IssueRow[];

  return (
    <main className="min-h-screen px-4 py-10">
      <div
        className="mx-auto max-w-[620px] rounded-xl bg-white shadow-lg p-8 sm:p-10"
        style={{ color: "#1a1a1a", fontFamily: cardFont, lineHeight: 1.55 }}
      >
        <p style={{ fontSize: 13, textTransform: "uppercase", letterSpacing: "0.08em", color: "#2d5e3e", margin: "0 0 4px" }}>
          RegenHub
        </p>
        <h1 style={{ margin: "0 0 6px", fontSize: 26 }}>Dispatches</h1>
        <p style={{ color: "#555", marginTop: 0 }}>
          Notes from the cooperative — what we&rsquo;ve been exploring, who&rsquo;s
          visited, and what&rsquo;s coming up.
        </p>

        {issues.length === 0 ? (
          <p style={{ color: "#888" }}>No dispatches yet — the first one is on its way.</p>
        ) : (
          <ul style={{ listStyle: "none", padding: 0, margin: "18px 0 0" }}>
            {issues.map((i) => (
              <li key={i.issue_key} style={{ padding: "12px 0", borderTop: "1px solid #eee" }}>
                <Link href={`/news/${i.issue_key}`} style={{ color: "#2d5e3e", fontWeight: 600, textDecoration: "none" }}>
                  {i.subject}
                </Link>
                <div style={{ fontSize: 12, color: "#888" }}>
                  {i.created_at
                    ? new Date(i.created_at).toLocaleDateString("en-US", { timeZone: "America/Denver", month: "long", day: "numeric", year: "numeric" })
                    : ""}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
