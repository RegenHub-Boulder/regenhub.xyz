import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import type { Interest } from "@/lib/supabase/types";
import { INTEREST_OPTIONS } from "@/lib/supabase/types";

export const metadata = { title: "Interests — Admin" };

const INTEREST_LABEL: Record<string, string> = Object.fromEntries(
  INTEREST_OPTIONS.map((o) => [o.value, o.label])
);

type Filter = "all" | "linked" | "unlinked";

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    timeZone: "America/Denver",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default async function InterestsPage({
  searchParams,
}: {
  searchParams: Promise<{ linked?: string }>;
}) {
  const params = await searchParams;
  const filter: Filter =
    params.linked === "true" ? "linked" : params.linked === "false" ? "unlinked" : "all";

  const supabase = await createClient();

  let query = supabase
    .from("interests")
    .select("*")
    .order("created_at", { ascending: false });

  if (filter === "linked") query = query.not("member_id", "is", null);
  if (filter === "unlinked") query = query.is("member_id", null);

  const { data } = await query;
  const interests = (data ?? []) as Interest[];

  // Counts for the filter pills (independent of current filter)
  const { data: counts } = await supabase
    .from("interests")
    .select("member_id");
  const total = counts?.length ?? 0;
  const linkedCount = counts?.filter((r) => r.member_id !== null).length ?? 0;
  const unlinkedCount = total - linkedCount;

  const filterLink = (f: Filter) => {
    if (f === "all") return "/admin/interests";
    if (f === "linked") return "/admin/interests?linked=true";
    return "/admin/interests?linked=false";
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-forest">Interest List</h1>
        <p className="text-muted text-sm mt-1">{total} signups</p>
      </div>

      <div className="flex gap-2 text-sm">
        {([
          ["all", `All (${total})`],
          ["linked", `Linked (${linkedCount})`],
          ["unlinked", `Unlinked (${unlinkedCount})`],
        ] as [Filter, string][]).map(([key, label]) => (
          <Link
            key={key}
            href={filterLink(key)}
            className={`glass-panel-subtle px-3 py-1.5 rounded-full transition-colors ${
              filter === key ? "ring-2 ring-sage text-foreground" : "text-muted hover:text-foreground"
            }`}
          >
            {label}
          </Link>
        ))}
      </div>

      {interests.length === 0 ? (
        <div className="glass-panel-subtle p-8 rounded-xl text-center text-muted">
          {filter === "all"
            ? <>No signups yet. Share <code className="text-sage">/interest</code> to start collecting.</>
            : filter === "linked"
              ? "No interests linked to a member yet."
              : "No unlinked interests."}
        </div>
      ) : (
        <div className="glass-panel rounded-xl overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wider text-muted border-b border-white/10">
              <tr>
                <th className="px-4 py-3 font-medium">Email</th>
                <th className="px-4 py-3 font-medium">Name</th>
                <th className="px-4 py-3 font-medium">Member</th>
                <th className="px-4 py-3 font-medium">Interests</th>
                <th className="px-4 py-3 font-medium">Source</th>
                <th className="px-4 py-3 font-medium">Signed up</th>
              </tr>
            </thead>
            <tbody>
              {interests.map((row) => (
                <tr key={row.id} className="border-b border-white/5 last:border-0">
                  <td className="px-4 py-3">
                    <a href={`mailto:${row.email}`} className="hover:text-sage transition-colors">
                      {row.email}
                    </a>
                  </td>
                  <td className="px-4 py-3 text-muted">{row.name ?? "—"}</td>
                  <td className="px-4 py-3">
                    {row.member_id !== null ? (
                      <Link
                        href={`/admin/members/${row.member_id}`}
                        className="inline-flex items-center gap-1 glass-panel-subtle px-2 py-0.5 text-xs rounded-full text-sage hover:ring-1 hover:ring-sage transition-colors"
                      >
                        ✓ Linked
                      </Link>
                    ) : (
                      <span className="text-muted text-xs">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {row.interests.length === 0 ? (
                      <span className="text-muted">—</span>
                    ) : (
                      <div className="flex flex-wrap gap-1">
                        {row.interests.map((i) => (
                          <span
                            key={i}
                            className="glass-panel-subtle px-2 py-0.5 text-xs rounded-full"
                          >
                            {INTEREST_LABEL[i] ?? i}
                          </span>
                        ))}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-muted text-xs">
                    {row.source_path ?? "—"}
                  </td>
                  <td className="px-4 py-3 text-muted text-xs whitespace-nowrap">
                    {formatDate(row.created_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
