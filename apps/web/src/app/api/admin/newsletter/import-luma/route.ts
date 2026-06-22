import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin";
import { createServiceClient } from "@/lib/supabase/admin";
import { fetchLumaContacts } from "@/lib/luma";

/**
 * POST — pull the RegenHub Luma calendar people and add the new ones to the
 * interests list (source_path='luma'), so they become part of the owned
 * newsletter audience. Deduped against existing interests + members by email
 * (interests has no unique email constraint, so we filter in app code). They
 * get one-click unsubscribe like any other recipient.
 */
export async function POST() {
  if (!(await requireAdmin())) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const admin = createServiceClient();
  const contacts = await fetchLumaContacts();
  if (!contacts.length) {
    return NextResponse.json({ fetched: 0, imported: 0, skipped: 0, note: "No Luma contacts (key missing or API error)" });
  }

  const [{ data: ints }, { data: mems }] = await Promise.all([
    admin.from("interests").select("email"),
    admin.from("members").select("email").not("email", "is", null),
  ]);
  const have = new Set<string>();
  for (const r of ints ?? []) if (r.email) have.add(r.email.toLowerCase());
  for (const r of mems ?? []) if (r.email) have.add(r.email.toLowerCase());

  const toInsert = contacts
    .filter((c) => !have.has(c.email))
    .map((c) => ({ email: c.email, name: c.name, source_path: "luma", interests: ["luma"] }));

  let imported = 0;
  for (let i = 0; i < toInsert.length; i += 500) {
    const chunk = toInsert.slice(i, i + 500);
    const { error } = await admin.from("interests").insert(chunk);
    if (error) {
      console.error("[Newsletter] Luma import insert failed:", error);
      break;
    }
    imported += chunk.length;
  }

  return NextResponse.json({ fetched: contacts.length, imported, skipped: contacts.length - imported });
}
