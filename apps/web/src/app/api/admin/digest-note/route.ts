import { requireAdminMember } from "@/lib/admin";
import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/admin";

/**
 * GET  /api/admin/digest-note — current unconsumed note (if any)
 * POST /api/admin/digest-note — set/replace the note for the next digest
 *
 * Only one note is "waiting" at a time: POSTing supersedes any prior
 * unconsumed note (we mark old ones consumed rather than deleting, so the
 * history stays browsable in the table).
 */

export async function GET() {
  const auth = await requireAdminMember();
  if (!auth) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

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
  const auth = await requireAdminMember();
  if (!auth) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

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
