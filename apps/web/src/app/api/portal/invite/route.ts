import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";
import crypto from "crypto";

/** Generate a short random invite code (8 uppercase alphanumeric chars) */
function generateInviteCode(): string {
  return crypto.randomBytes(5).toString("base64url").slice(0, 8).toUpperCase();
}

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createServiceClient();

  const { data: member } = await admin
    .from("members")
    .select("id, name, is_coop_member, invite_code")
    .eq("supabase_user_id", user.id)
    .single();

  if (!member) {
    return NextResponse.json({ error: "Member not found" }, { status: 404 });
  }

  if (!member.is_coop_member) {
    return NextResponse.json(
      { error: "Only cooperative members can create invite links" },
      { status: 403 }
    );
  }

  let inviteCode = member.invite_code;

  // Generate a code if they don't have one yet
  if (!inviteCode) {
    // Retry loop in case of (extremely unlikely) collision
    for (let attempt = 0; attempt < 5; attempt++) {
      inviteCode = generateInviteCode();
      const { error } = await admin
        .from("members")
        .update({ invite_code: inviteCode })
        .eq("id", member.id);

      if (!error) break;

      // Unique constraint violation — try again
      if (error.code === "23505") {
        inviteCode = null;
        continue;
      }

      console.error("[Invite] Failed to save invite code:", error);
      return NextResponse.json(
        { error: "Failed to generate invite code" },
        { status: 500 }
      );
    }

    if (!inviteCode) {
      return NextResponse.json(
        { error: "Failed to generate a unique invite code" },
        { status: 500 }
      );
    }
  }

  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "https://regenhub.xyz";
  const inviteUrl = `${siteUrl}/freeday?ref=${inviteCode}`;

  return NextResponse.json({
    invite_code: inviteCode,
    invite_url: inviteUrl,
  });
}
