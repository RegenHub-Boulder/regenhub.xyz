import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin";
import { createServiceClient } from "@/lib/supabase/admin";
import { readAll } from "@/lib/supabase/readAll";
import { planLumaImport, readLumaCsv } from "@/lib/lumaCsv";

/** A Luma export of a few thousand people is well under this. */
const MAX_CSV_CHARS = 5_000_000;

/**
 * POST { csv, commit? } — a Luma people or event-guests CSV export (lib/lumaCsv.ts) into the newsletter's
 * interests list (source_path 'luma'), with one-click unsubscribe like any recipient. No Luma API: the admin
 * uploads the export.
 *
 * Skipped: rows Luma marks unsubscribed, guests only invited or declined, invalid emails, repeats in the file,
 * anyone already in the audience (an enabled member, or on the interests list; compileAudience's sources), and
 * anyone who unsubscribed from our newsletter. Without `commit` it's a dry run: the same
 * counts, nothing written. With it, the counts are worked out again from the lists as they are now, then the
 * new rows are inserted.
 *   → { rows, add, alreadyHave, unsubscribedHere, unsubscribedOnLuma, notRegistered, invalid, duplicate, imported? }
 */
export async function POST(req: Request) {
  if (!(await requireAdmin())) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = (await req.json().catch(() => null)) as { csv?: unknown; commit?: unknown } | null;
  if (typeof body?.csv !== "string" || !body.csv.trim()) {
    return NextResponse.json({ error: "Choose a Luma CSV export first." }, { status: 400 });
  }
  if (body.csv.length > MAX_CSV_CHARS) return NextResponse.json({ error: "That file is too big for one import." }, { status: 413 });
  const read = readLumaCsv(body.csv);
  if ("error" in read) return NextResponse.json({ error: read.error }, { status: 400 });

  const admin = createServiceClient();
  let have: Set<string>;
  let unsubscribed: Set<string>;
  try {
    const [interests, members, unsubs] = await Promise.all([
      readAll<{ email: string | null }>("interests", (f, t) =>
        admin.from("interests").select("id, email").order("id", { ascending: true }).range(f, t)),
      readAll<{ email: string | null }>("members", (f, t) =>
        admin.from("members").select("id, email").eq("disabled", false).not("email", "is", null).order("id", { ascending: true }).range(f, t)),
      readAll<{ email: string }>("email_unsubscribes", (f, t) =>
        admin.from("email_unsubscribes").select("email").order("email", { ascending: true }).range(f, t)),
    ]);
    have = new Set([...interests, ...members].flatMap((r) => (r.email ? [r.email.trim().toLowerCase()] : [])));
    unsubscribed = new Set(unsubs.map((u) => u.email.trim().toLowerCase()));
  } catch (err) {
    // An unread unsubscribe list must never mean adding back people who left.
    console.error("[Newsletter] Luma CSV import: list read failed:", err);
    return NextResponse.json({ error: "Couldn't read the current lists. Nothing was imported; try again." }, { status: 503 });
  }

  const plan = planLumaImport(read.contacts, have, unsubscribed);
  const summary = {
    rows: read.rows,
    add: plan.add.length,
    alreadyHave: plan.alreadyHave,
    unsubscribedHere: plan.unsubscribedHere,
    unsubscribedOnLuma: read.unsubscribedOnLuma,
    notRegistered: read.notRegistered,
    invalid: read.invalid,
    duplicate: read.duplicate,
  };
  if (body.commit !== true) return NextResponse.json(summary);

  let imported = 0;
  for (let i = 0; i < plan.add.length; i += 500) {
    const chunk = plan.add.slice(i, i + 500).map((c) => ({ email: c.email, name: c.name, source_path: "luma", interests: ["luma"] }));
    const { error } = await admin.from("interests").insert(chunk);
    if (error) {
      console.error("[Newsletter] Luma CSV import insert failed:", error);
      return NextResponse.json(
        { ...summary, imported, error: `Stopped after ${imported} of ${plan.add.length}: ${error.message}. Run it again to add the rest.` },
        { status: 500 },
      );
    }
    imported += chunk.length;
  }
  return NextResponse.json({ ...summary, imported });
}
