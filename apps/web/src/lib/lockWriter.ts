import { NextResponse } from "next/server";
import { LockWriterBusyError, recordLockWriterFailure, withLockWriter } from "@regenhub/shared";
import { createServiceClient } from "@/lib/supabase/admin";

/** What an admin or member reads when a door-code change didn't go through for a reason other than "busy". */
export const LOCK_WRITE_FAILED_MESSAGE = "The door-code change didn't go through; try again in a minute. If it keeps failing, tell an admin.";

/** The plain answer for a failed writer scope: busy (nothing ran) or a failure part-way. */
export function lockWriterErrorMessage(error: unknown): string {
  return error instanceof LockWriterBusyError ? error.message : LOCK_WRITE_FAILED_MESSAGE;
}

export async function withWebLockWriter(work: () => Promise<Response>): Promise<Response> {
  const db = createServiceClient();
  try {
    return await withLockWriter(db, work, "Web PIN writer");
  } catch (error) {
    console.error("[LockWriter] PIN operation failed:", error);
    // A busy acquire is recorded by withLockWriter itself; anything else is recorded here.
    if (!(error instanceof LockWriterBusyError)) await recordLockWriterFailure(db, "Web PIN writer", error);
    return NextResponse.json({ error: lockWriterErrorMessage(error) }, { status: 503 });
  }
}
