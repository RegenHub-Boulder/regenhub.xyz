import { NextResponse } from "next/server";
import { isStandInEnabled } from "@/lib/techne/config";
import { stagingOutboxMails } from "@/lib/staging/outbox";

/** STAGING ONLY: the latest email the preview would have sent (lib/staging/outbox.ts). 404 elsewhere. */
export const dynamic = "force-dynamic";

export function GET() {
  const mail = stagingOutboxMails()[0];
  if (!isStandInEnabled() || !mail) return NextResponse.json({ error: "NotFound" }, { status: 404 });
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  return new NextResponse(
    `<!doctype html><meta name="viewport" content="width=device-width"><title>${esc(mail.subject)}</title>` +
      `<div style="font:14px system-ui;padding:12px 16px;background:#eee;color:#333">Staging inbox · to ${esc(mail.to)}<br><b>${esc(mail.subject)}</b></div>${mail.html}`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );
}
