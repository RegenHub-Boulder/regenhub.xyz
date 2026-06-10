import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";

/**
 * GET  /api/admin/digest-note — current unconsumed note (if any)
 * POST /api/admin/digest-note — set/replace the note for the next digest
 *
 * Only one note is "waiting" at a time: POSTing supersedes any prior
 * unconsumed note (we mark old ones consumed rather than deleting, so the
 * history stays browsable in the table).
 */

async function requireAdmin() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "Unauthorized" as const, status: 401 as const };
  const { data: member } = await supabase
    .from("members")
    .select("id, is_admin")
    .eq("supabase_user_id", user.id)
    .single();
  if (!member?.is_admin) return { error: "Forbidden" as const, status: 403 as const };
  return { member };
}

export async function GET() {
  const auth = await requireAdmin();
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const admin = createServiceClient();
  const { data } = await admin
    .from("digest_notes")
    .select("id, note, created_at, author_member_id")
    .is("consumed_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return NextResponse.json({ note: data ?? null });
}

export async function POST(req: Request) {
  const auth = await requireAdmin();
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const body = (await req.json().catch(() => null)) as { note?: string } | null;
  const note = body?.note?.trim();
  if (!note) return NextResponse.json({ error: "note required" }, { status: 400 });
  if (note.length > 2000) return NextResponse.json({ error: "note too long (2000 chars max)" }, { status: 400 });

  const admin = createServiceClient();

  // Supersede any prior unconsumed note.
  await admin
    .from("digest_notes")
    .update({ consumed_at: new Date().toISOString() })
    .is("consumed_at", null);

  const { error } = await admin.from("digest_notes").insert({
    note,
    author_member_id: auth.member.id,
  });
  if (error) {
    console.error("[DigestNote] insert error:", error);
    return NextResponse.json({ error: "Save failed" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
