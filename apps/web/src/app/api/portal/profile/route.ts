import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";

/**
 * PATCH /api/portal/profile
 *
 * Lets a signed-in member update their own profile. Uses the service-role
 * client because direct UPDATE on `members` is REVOKE'd from authenticated
 * (see migration 031) — letting members write directly was a privilege-
 * escalation foothold (they could flip is_admin or mint day passes by
 * bypassing this route entirely). We hand-pick the writeable columns here.
 */
export async function PATCH(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const { name, bio, skills, telegram_username, ethereum_address, profile_photo_url } = body;

  if (profile_photo_url && typeof profile_photo_url === "string") {
    if (!/^https?:\/\//i.test(profile_photo_url)) {
      return NextResponse.json(
        { error: "Profile photo URL must start with http:// or https://" },
        { status: 400 },
      );
    }
  }

  // Service client + an explicit supabase_user_id filter is what scopes this
  // write to the caller's own row. Don't add columns to the update payload
  // unless they're safe for self-edit.
  const admin = createServiceClient();
  const { error } = await admin
    .from("members")
    .update({
      ...(name !== undefined && { name }),
      ...(bio !== undefined && { bio }),
      ...(skills !== undefined && { skills }),
      ...(telegram_username !== undefined && { telegram_username }),
      ...(ethereum_address !== undefined && { ethereum_address }),
      ...(profile_photo_url !== undefined && { profile_photo_url }),
    })
    .eq("supabase_user_id", user.id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
