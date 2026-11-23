import Link from "next/link";
import { PORTAL_FIXTURES } from "@/lib/portalFixtures";
import { currentViewAs, previewFrame } from "@/lib/viewAsServer";

export const metadata = { title: "View the portal as… — Admin" };

/**
 * Pick a kind of member and see /portal as they would (lib/viewAs.ts): a fictional member, no real data, read-only.
 * One real member's portal opens from their page (People → Members → See their portal). The staff layout already
 * holds this page to active admins; entering checks again (POST /api/admin/view-as).
 */
export default async function ViewAsPage() {
  const viewAs = await currentViewAs();
  const current = viewAs ? await previewFrame(viewAs) : null;
  return (
    <div className="max-w-3xl space-y-6">
      <header>
        <h1 className="text-3xl font-bold text-forest">View the portal as…</h1>
        <p className="text-muted mt-1">
          The member home as each kind of member sees it. Sample people, placeholder door codes, nothing can be changed.
          For one real member, open them in <Link href="/admin/members" className="text-sage hover:underline">Members</Link> and
          choose &ldquo;See their portal&rdquo;.
        </p>
        {current && <p className="text-sm mt-2">Now viewing as {current.label}.</p>}
      </header>

      <ul className="divide-y divide-rule border-y border-rule" data-testid="view-as-picker">
        {PORTAL_FIXTURES.map((f) => (
          <li key={f.key}>
            <form action="/api/admin/view-as" method="post" className="flex items-baseline justify-between gap-4 py-3">
              <input type="hidden" name="fixture" value={f.key} />
              <div className="min-w-0">
                <p className="font-medium first-letter:uppercase">{f.label}</p>
                <p className="text-sm text-muted">{f.shows}</p>
              </div>
              <button type="submit" className="text-sm text-sage hover:underline shrink-0">View →</button>
            </form>
          </li>
        ))}
      </ul>
    </div>
  );
}
