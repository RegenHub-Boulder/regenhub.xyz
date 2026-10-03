import { NextResponse } from "next/server";
import { withLockWriter } from "@regenhub/shared";
import { createServiceClient } from "@/lib/supabase/admin";

export async function withWebLockWriter(work: () => Promise<Response>): Promise<Response> {
  try {
    return await withLockWriter(createServiceClient(), work);
  } catch (error) {
    console.error("[LockWriter] PIN operation failed:", error);
    return NextResponse.json({ error: "Door-code operation unavailable; retry later or contact an admin." }, { status: 503 });
  }
}
