import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";
import { WORKING_ON_MAX, normalizeLinks } from "@/lib/memberDirectory";

/**
 * PATCH /api/portal/profile
 *
 * Lets a signed-in member update their own profile. Uses the service-role
 * client because direct UPDATE on `members` is REVOKE'd from authenticated
 * (see migration 031) — letting members write directly was a privilege-
 * escalation foothold (they could flip is_admin or mint day passes by
 * bypassing this route entirely). We hand-pick the writeable columns here.
 *
 * The member page fields (migration 065): `working_on` (one line), `links` (up to five http(s) URLs),
 * `show_in_directory` and `show_rsvps` (booleans). Whether they're shown at all is lib/memberDirectory.ts's call.
 */
export async function PATCH(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") return NextResponse.json({ error: "Expected a JSON object" }, { status: 400 });
  const { name, bio, skills, telegram_username, ethereum_address, profile_photo_url, working_on, show_in_directory, show_rsvps } = body;

  if (working_on !== undefined && working_on !== null && (typeof working_on !== "string" || working_on.trim().length > WORKING_ON_MAX)) {
    return NextResponse.json({ error: `"Working on" is one line, up to ${WORKING_ON_MAX} characters.` }, { status: 400 });
  }
  for (const [key, value] of [["show_in_directory", show_in_directory], ["show_rsvps", show_rsvps]] as const) {
    if (value !== undefined && typeof value !== "boolean") {
      return NextResponse.json({ error: `${key} must be true or false` }, { status: 400 });
    }
  }
  let links: string[] | undefined;
  if (body.links !== undefined) {
    const checked = normalizeLinks(body.links);
    if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: 400 });
    links = checked.links;
  }

  if (profile_photo_url && typeof profile_photo_url === "string") {
    if (!/^https?:\/\//i.test(profile_photo_url)) {
      return NextResponse.json(
        { error: "Profile photo URL must start with http:// or https://" },
        { status: 400 },
      );
    }
  }

  const admin = createServiceClient();

  // Telegram handle op-sec: the bot resolves members by the sender's handle,
  // so a handle may only live on one member row (enforced by a unique index,
  // migration 036). Pre-check here for a friendly error instead of a 500.
  let normalizedTelegram: string | null | undefined = undefined;
  if (telegram_username !== undefined) {
    const t = String(telegram_username ?? "").trim().replace(/^@+/, "");
    if (t === "") {
      normalizedTelegram = null;
    } else if (!/^[a-zA-Z0-9_]{5,32}$/.test(t)) {
      return NextResponse.json(
        { error: "Telegram username must be 5-32 characters (letters, numbers, underscore)" },
        { status: 400 },
      );
    } else {
      // Historic rows may store the handle with a leading @ — match both forms.
      const { data: holder } = await admin
        .from("members")
        .select("id, supabase_user_id")
        .or(`telegram_username.ilike.${t},telegram_username.ilike.@${t}`)
        .maybeSingle();
      if (holder && holder.supabase_user_id !== user.id) {
        return NextResponse.json(
          { error: "That Telegram username is already linked to another member. If it's yours, email us and we'll sort it out." },
          { status: 409 },
        );
      }
      normalizedTelegram = t;
    }
  }

  // Service client + an explicit supabase_user_id filter is what scopes this
  // write to the caller's own row. Don't add columns to the update payload
  // unless they're safe for self-edit.
  const { error } = await admin
    .from("members")
    .update({
      ...(name !== undefined && { name }),
      ...(bio !== undefined && { bio }),
      ...(skills !== undefined && { skills }),
      ...(normalizedTelegram !== undefined && { telegram_username: normalizedTelegram }),
      ...(ethereum_address !== undefined && { ethereum_address }),
      ...(profile_photo_url !== undefined && { profile_photo_url }),
      ...(working_on !== undefined && { working_on: working_on?.trim() || null }),
      ...(links !== undefined && { links }),
      ...(show_in_directory !== undefined && { show_in_directory }),
      ...(show_rsvps !== undefined && { show_rsvps }),
    })
    .eq("supabase_user_id", user.id);

  if (error) {
    // 23505 = the unique index caught a race the pre-check missed.
    if ((error as { code?: string }).code === "23505") {
      return NextResponse.json(
        { error: "That Telegram username is already linked to another member." },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
