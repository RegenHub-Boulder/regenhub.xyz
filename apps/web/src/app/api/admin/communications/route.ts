import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";
import { sendEmail } from "@/lib/email";
import { logAction, AuditAction } from "@/lib/auditLog";

/**
 * POST /api/admin/communications
 *
 * Filter members by criteria, preview or send a personalized email to each.
 *
 * Body:
 *   {
 *     filter: {
 *       member_type?: ("cold_desk" | "hot_desk" | "hub_friend" | "day_pass")[];
 *       signup_window_days?: number;   // members.created_at within this many days
 *       has_active_subscription?: boolean;
 *       approved_for_daily?: boolean;
 *       approved_for_full?: boolean;
 *       day_passes_balance_at_least?: number;
 *       email_in?: string[];           // explicit email allow-list
 *     },
 *     subject: string,                 // supports {firstName} / {name} placeholders
 *     body_html: string,               // supports {firstName} / {name} placeholders
 *     batch_id: string,                // idempotency key prefix — same id won't re-send
 *     preview?: boolean,               // true = dry-run, no sends
 *   }
 *
 * Per-recipient idempotency:
 *   admin_actions row is written per send with idempotency_key = `${batch_id}:${member.id}`
 *   Re-running with the same batch_id re-targets only members who DON'T already
 *   have an admin_actions row for that batch.
 *
 * Rate limiting:
 *   We sleep 250ms between sends to stay comfortably under Resend's 5/sec cap.
 *
 * Auth: requires admin (matches the rest of /api/admin/* routes).
 */

const RATE_LIMIT_DELAY_MS = 250;
const MAX_RECIPIENTS_PER_CALL = 250;

interface Filter {
  member_type?: string[];
  signup_window_days?: number;
  has_active_subscription?: boolean;
  approved_for_daily?: boolean;
  approved_for_full?: boolean;
  day_passes_balance_at_least?: number;
  email_in?: string[];
}

interface Body {
  filter: Filter;
  subject: string;
  body_html: string;
  batch_id: string;
  preview?: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function personalize(template: string, name: string): string {
  const firstName = name.split(" ")[0] || name;
  return template.replace(/\{firstName\}/g, firstName).replace(/\{name\}/g, name);
}

function htmlToText(html: string): string {
  return html.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").trim();
}

export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: adminMember } = await supabase
    .from("members")
    .select("id, is_admin")
    .eq("supabase_user_id", user.id)
    .single();
  if (!adminMember?.is_admin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as Body | null;
  if (!body?.filter || !body.subject || !body.body_html || !body.batch_id) {
    return NextResponse.json({ error: "filter, subject, body_html, batch_id required" }, { status: 400 });
  }
  if (!/^[a-zA-Z0-9_\-:]{3,80}$/.test(body.batch_id)) {
    return NextResponse.json({ error: "batch_id must be 3-80 chars, alphanumeric/underscore/dash/colon" }, { status: 400 });
  }

  const admin = createServiceClient();

  // Build the query
  let q = admin
    .from("members")
    .select("id, name, email, member_type, day_passes_balance, approved_for_daily, approved_for_full, created_at")
    .eq("disabled", false)
    .not("email", "is", null);

  if (body.filter.member_type?.length) q = q.in("member_type", body.filter.member_type);
  if (body.filter.approved_for_daily != null) q = q.eq("approved_for_daily", body.filter.approved_for_daily);
  if (body.filter.approved_for_full != null) q = q.eq("approved_for_full", body.filter.approved_for_full);
  if (body.filter.day_passes_balance_at_least != null) q = q.gte("day_passes_balance", body.filter.day_passes_balance_at_least);
  if (body.filter.signup_window_days != null) {
    const since = new Date(Date.now() - body.filter.signup_window_days * 24 * 60 * 60 * 1000).toISOString();
    q = q.gte("created_at", since);
  }
  if (body.filter.email_in?.length) {
    q = q.in("email", body.filter.email_in.map((e) => e.trim().toLowerCase()));
  }

  const { data: candidates, error: qErr } = await q.limit(MAX_RECIPIENTS_PER_CALL);
  if (qErr) {
    return NextResponse.json({ error: qErr.message }, { status: 500 });
  }

  let recipients = candidates ?? [];

  // has_active_subscription requires a join — done here in a second query if asked
  if (body.filter.has_active_subscription != null && recipients.length > 0) {
    const { data: subs } = await admin
      .from("subscriptions")
      .select("member_id")
      .in("status", ["active", "trialing", "past_due"])
      .in("member_id", recipients.map((r) => r.id));
    const subSet = new Set((subs ?? []).map((s) => s.member_id));
    recipients = recipients.filter((r) => subSet.has(r.id) === body.filter.has_active_subscription);
  }

  // Pull out any recipients who have already received this batch (idempotency).
  if (recipients.length > 0) {
    const { data: prior } = await admin
      .from("admin_actions")
      .select("target_id")
      .eq("action", AuditAction.BATCH_EMAIL_SENT)
      .like("idempotency_key", `${body.batch_id}:%`);
    const alreadySentTo = new Set((prior ?? []).map((p) => p.target_id));
    recipients = recipients.filter((r) => !alreadySentTo.has(String(r.id)));
  }

  if (body.preview) {
    return NextResponse.json({
      preview: true,
      total: recipients.length,
      recipients: recipients.map((r) => ({
        id: r.id,
        name: r.name,
        email: r.email,
        personalized_subject: personalize(body.subject, r.name),
      })),
    });
  }

  // Real send
  const results: Array<{
    member_id: number;
    email: string;
    ok: boolean;
    error?: string;
  }> = [];

  for (const m of recipients) {
    if (!m.email) continue;
    const subject = personalize(body.subject, m.name);
    const html = personalize(body.body_html, m.name);
    const text = htmlToText(html);
    try {
      const sent = await sendEmail({ to: m.email, subject, html, text });
      results.push({ member_id: m.id, email: m.email, ok: sent });
      if (sent) {
        await logAction(
          {
            action: AuditAction.BATCH_EMAIL_SENT,
            actorMemberId: adminMember.id,
            target: { table: "members", id: m.id },
            idempotencyKey: `${body.batch_id}:${m.id}`,
            payload: { batch_id: body.batch_id, subject, length: html.length },
          },
          admin,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      results.push({ member_id: m.id, email: m.email, ok: false, error: msg });
    }
    await sleep(RATE_LIMIT_DELAY_MS);
  }

  return NextResponse.json({
    preview: false,
    total: results.length,
    sent: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results,
  });
}
