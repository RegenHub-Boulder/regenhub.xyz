import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { isStylePreviewEnabled } from "@/lib/stylePreview";

/**
 * STAGING ONLY (T-482): the picker's screenshots, read from the worktree's walkthrough/style-directions/ (or
 * STYLE_PREVIEW_SHOTS_DIR) so they never ship in public/. 404 unless the preview switch is on.
 */
export const dynamic = "force-dynamic";

function shotsDir(): string {
  return process.env.STYLE_PREVIEW_SHOTS_DIR?.trim() || path.resolve(process.cwd(), "../../walkthrough/style-directions");
}

const STYLE = /^(base|book|field|studio)$/;
const FILE = /^\d{2}-[a-z-]+\.png$/;

export async function GET(_req: Request, { params }: { params: Promise<{ style: string; file: string }> }) {
  const { style, file } = await params;
  if (!isStylePreviewEnabled() || !STYLE.test(style) || !FILE.test(file)) {
    return NextResponse.json({ error: "NotFound" }, { status: 404 });
  }
  try {
    const png = await readFile(path.join(shotsDir(), style, file));
    return new NextResponse(new Uint8Array(png), {
      headers: { "content-type": "image/png", "cache-control": "no-store" },
    });
  } catch {
    return NextResponse.json({ error: "NotFound" }, { status: 404 });
  }
}
