import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/admin";
import { INTEREST_OPTIONS } from "@/lib/supabase/types";

const VALID_INTERESTS = new Set<string>(INTEREST_OPTIONS.map((o) => o.value));

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

  const { email, name, interests, source_path } = body as {
    email?: string;
    name?: string;
    interests?: unknown;
    source_path?: string;
  };

  if (!email?.trim()) {
    return NextResponse.json({ error: "Email is required" }, { status: 400 });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: "Invalid email address" }, { status: 400 });
  }

  const validInterests = Array.isArray(interests)
    ? interests.filter((i): i is string => typeof i === "string" && VALID_INTERESTS.has(i))
    : [];

  const normalizedEmail = email.trim().toLowerCase();
  const supabase = createServiceClient();

  // If a member already exists for this email, link the interest at signup time.
  // The signup-second-member-first case is also covered by the auth-side trigger
  // in migration 020, but going direct here saves a round trip when the member
  // exists today.
  const { data: existingMember } = await supabase
    .from("members")
    .select("id")
    .ilike("email", normalizedEmail)
    .maybeSingle();

  const { error } = await supabase.from("interests").insert({
    email: normalizedEmail,
    name: name?.trim() || null,
    interests: validInterests,
    source_path: source_path?.slice(0, 500) ?? null,
    member_id: existingMember?.id ?? null,
  });

  if (error) {
    console.error("[Interest] DB error:", error);
    return NextResponse.json({ error: "Failed to save" }, { status: 500 });
  }

  return NextResponse.json({ submitted: true });
}
