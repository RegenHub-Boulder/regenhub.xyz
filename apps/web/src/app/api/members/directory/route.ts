import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/admin";

export type DirectoryMember = {
  name: string;
  bio: string | null;
  skills: string[] | null;
  profile_photo_url: string | null;
  member_type: string;
};

export async function GET() {
  const supabase = createServiceClient();

  const { data, error } = await supabase
    .from("members")
    .select("name, bio, skills, profile_photo_url, member_type")
    .eq("show_in_directory", true)
    .eq("disabled", false)
    .neq("member_type", "day_pass")
    .order("name");

  if (error) {
    console.error("[Directory] DB error:", error);
    return NextResponse.json({ members: [] });
  }

  return NextResponse.json({ members: data as DirectoryMember[] });
}
