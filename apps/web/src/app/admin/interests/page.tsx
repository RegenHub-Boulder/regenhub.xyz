import { createClient } from "@/lib/supabase/server";
import type { Interest } from "@/lib/supabase/types";
import { INTEREST_OPTIONS } from "@/lib/supabase/types";

export const metadata = { title: "Interests — Admin" };

const INTEREST_LABEL: Record<string, string> = Object.fromEntries(
  INTEREST_OPTIONS.map((o) => [o.value, o.label])
);

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

export default async function InterestsPage() {
  const supabase = await createClient();

  const { data } = await supabase
    .from("interests")
    .select("*")
    .order("created_at", { ascending: false });

  const interests = (data ?? []) as Interest[];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-forest">Interest List</h1>
        <p className="text-muted text-sm mt-1">{interests.length} signups</p>
      </div>

      {interests.length === 0 ? (
        <div className="glass-panel-subtle p-8 rounded-xl text-center text-muted">
          No signups yet. Share <code className="text-sage">/interest</code> to start collecting.
        </div>
      ) : (
        <div className="glass-panel rounded-xl overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wider text-muted border-b border-white/10">
              <tr>
                <th className="px-4 py-3 font-medium">Email</th>
                <th className="px-4 py-3 font-medium">Name</th>
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
