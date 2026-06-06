"use client";

import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Send, Eye, Users } from "lucide-react";

const MEMBER_TYPES = [
  { key: "day_pass", label: "Day Pass" },
  { key: "hub_friend", label: "Hub Friend" },
  { key: "hot_desk", label: "Hot Desk" },
  { key: "cold_desk", label: "Cold Desk" },
];

interface PreviewResult {
  preview: true;
  total: number;
  recipients: Array<{ id: number; name: string; email: string; personalized_subject: string }>;
}

interface SendResult {
  preview: false;
  total: number;
  sent: number;
  failed: number;
  results: Array<{ member_id: number; email: string; ok: boolean; error?: string }>;
}

export function CommunicationsComposer() {
  const [selectedTypes, setSelectedTypes] = useState<Set<string>>(new Set());
  const [signupWindowDays, setSignupWindowDays] = useState("");
  const [approvedForDaily, setApprovedForDaily] = useState<"any" | "true" | "false">("any");
  const [approvedForFull, setApprovedForFull] = useState<"any" | "true" | "false">("any");
  const [hasActiveSubscription, setHasActiveSubscription] = useState<"any" | "true" | "false">("any");
  const [balanceAtLeast, setBalanceAtLeast] = useState("");
  const [emailIn, setEmailIn] = useState("");

  const [subject, setSubject] = useState("");
  const [bodyHtml, setBodyHtml] = useState("");
  const [batchId, setBatchId] = useState("");

  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [sendResult, setSendResult] = useState<SendResult | null>(null);
  const [busy, setBusy] = useState<"preview" | "send" | null>(null);
  const [error, setError] = useState<string | null>(null);

  function toggleType(key: string) {
    setSelectedTypes((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function buildFilter(): Record<string, unknown> {
    const f: Record<string, unknown> = {};
    if (selectedTypes.size > 0) f.member_type = Array.from(selectedTypes);
    if (signupWindowDays) f.signup_window_days = parseInt(signupWindowDays, 10);
    if (approvedForDaily !== "any") f.approved_for_daily = approvedForDaily === "true";
    if (approvedForFull !== "any") f.approved_for_full = approvedForFull === "true";
    if (hasActiveSubscription !== "any") f.has_active_subscription = hasActiveSubscription === "true";
    if (balanceAtLeast) f.day_passes_balance_at_least = parseInt(balanceAtLeast, 10);
    if (emailIn.trim()) {
      f.email_in = emailIn.split(/[\s,;]+/).map((e) => e.trim()).filter(Boolean);
    }
    return f;
  }

  async function call(previewMode: boolean) {
    setBusy(previewMode ? "preview" : "send");
    setError(null);
    if (previewMode) setPreview(null);
    else setSendResult(null);

    try {
      const res = await fetch("/api/admin/communications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filter: buildFilter(),
          subject,
          body_html: bodyHtml,
          batch_id: batchId.trim(),
          preview: previewMode,
        }),
      });
      const raw = await res.text();
      let data: PreviewResult | SendResult | { error: string } | null = null;
      if (raw) {
        try { data = JSON.parse(raw); } catch { /* keep null */ }
      }
      if (!res.ok || !data) {
        setError((data as { error?: string })?.error ?? `HTTP ${res.status}`);
        return;
      }
      if (previewMode) setPreview(data as PreviewResult);
      else setSendResult(data as SendResult);
    } finally {
      setBusy(null);
    }
  }

  const canPreview = subject.trim() && bodyHtml.trim() && batchId.trim();
  const canSend = canPreview && preview && preview.total > 0;

  return (
    <div className="space-y-6">
      {/* Filter */}
      <Card className="glass-panel">
        <CardContent className="p-5 space-y-4">
          <h3 className="text-sm font-semibold flex items-center gap-2">
            <Users className="w-4 h-4 text-sage" /> Audience
          </h3>

          <div>
            <p className="text-xs text-muted mb-1.5 font-medium">Member type (any selected)</p>
            <div className="flex flex-wrap gap-1.5">
              {MEMBER_TYPES.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => toggleType(t.key)}
                  className={`px-2.5 py-1 rounded text-xs border ${
                    selectedTypes.has(t.key)
                      ? "bg-sage/20 border-sage/50 text-sage"
                      : "bg-white/5 border-white/10 text-muted hover:bg-white/10"
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          <div className="grid sm:grid-cols-2 gap-3">
            <div>
              <Label htmlFor="signup" className="text-xs">Signed up in last N days</Label>
              <Input id="signup" type="number" min="1" value={signupWindowDays} onChange={(e) => setSignupWindowDays(e.target.value)} placeholder="e.g. 7" className="glass-input mt-1 text-sm" />
            </div>
            <div>
              <Label htmlFor="balance" className="text-xs">Day-pass balance ≥</Label>
              <Input id="balance" type="number" min="0" value={balanceAtLeast} onChange={(e) => setBalanceAtLeast(e.target.value)} placeholder="e.g. 1" className="glass-input mt-1 text-sm" />
            </div>
            <div>
              <Label className="text-xs">Approved for Daily</Label>
              <select value={approvedForDaily} onChange={(e) => setApprovedForDaily(e.target.value as "any" | "true" | "false")} className="glass-input mt-1 text-sm w-full px-2 py-1.5 rounded">
                <option value="any">Any</option>
                <option value="true">Yes</option>
                <option value="false">No</option>
              </select>
            </div>
            <div>
              <Label className="text-xs">Approved for Full</Label>
              <select value={approvedForFull} onChange={(e) => setApprovedForFull(e.target.value as "any" | "true" | "false")} className="glass-input mt-1 text-sm w-full px-2 py-1.5 rounded">
                <option value="any">Any</option>
                <option value="true">Yes</option>
                <option value="false">No</option>
              </select>
            </div>
            <div>
              <Label className="text-xs">Has active subscription</Label>
              <select value={hasActiveSubscription} onChange={(e) => setHasActiveSubscription(e.target.value as "any" | "true" | "false")} className="glass-input mt-1 text-sm w-full px-2 py-1.5 rounded">
                <option value="any">Any</option>
                <option value="true">Yes</option>
                <option value="false">No</option>
              </select>
            </div>
          </div>

          <div>
            <Label htmlFor="emails" className="text-xs">Explicit email list (overrides other filters)</Label>
            <textarea
              id="emails"
              value={emailIn}
              onChange={(e) => setEmailIn(e.target.value)}
              placeholder="Paste comma- or newline-separated emails"
              rows={3}
              className="glass-input mt-1 w-full text-sm font-mono px-2 py-1.5 rounded"
            />
          </div>
        </CardContent>
      </Card>

      {/* Composer */}
      <Card className="glass-panel">
        <CardContent className="p-5 space-y-4">
          <h3 className="text-sm font-semibold">Message</h3>

          <div>
            <Label htmlFor="batch_id" className="text-xs">Batch ID (idempotency key)</Label>
            <Input id="batch_id" value={batchId} onChange={(e) => setBatchId(e.target.value)} placeholder="e.g. 2026-06-15-summer-event" className="glass-input mt-1 text-sm font-mono" />
            <p className="text-[10px] text-muted mt-1">Re-running with the same batch ID will skip anyone who already received this batch.</p>
          </div>

          <div>
            <Label htmlFor="subject" className="text-xs">Subject (supports {`{firstName}`} / {`{name}`})</Label>
            <Input id="subject" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="e.g. {firstName}, your monthly day passes are ready" className="glass-input mt-1 text-sm" />
          </div>

          <div>
            <Label htmlFor="body" className="text-xs">Body HTML (supports {`{firstName}`} / {`{name}`})</Label>
            <textarea
              id="body"
              value={bodyHtml}
              onChange={(e) => setBodyHtml(e.target.value)}
              rows={12}
              placeholder="<p>Hi {firstName},</p><p>…</p>"
              className="glass-input mt-1 w-full text-sm font-mono px-3 py-2 rounded"
            />
          </div>
        </CardContent>
      </Card>

      {/* Actions */}
      <div className="flex gap-2 flex-wrap">
        <Button onClick={() => call(true)} disabled={!canPreview || busy !== null} className="btn-glass gap-2">
          {busy === "preview" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Eye className="w-4 h-4" />}
          Preview audience
        </Button>
        <Button onClick={() => call(false)} disabled={!canSend || busy !== null} className="btn-primary-glass gap-2">
          {busy === "send" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          Send to {preview?.total ?? "?"} {preview?.total === 1 ? "person" : "people"}
        </Button>
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}

      {preview && (
        <Card className="glass-panel border border-sage/30">
          <CardContent className="p-5">
            <p className="text-sm font-medium mb-2">{preview.total} {preview.total === 1 ? "recipient" : "recipients"}</p>
            {preview.total === 0 ? (
              <p className="text-xs text-muted italic">No one matches that filter (or they all already received this batch).</p>
            ) : (
              <ul className="text-xs space-y-1 max-h-64 overflow-y-auto">
                {preview.recipients.slice(0, 50).map((r) => (
                  <li key={r.id} className="text-muted">
                    <span className="text-foreground">{r.name}</span> · {r.email}
                  </li>
                ))}
                {preview.recipients.length > 50 && (
                  <li className="text-muted italic">… plus {preview.recipients.length - 50} more</li>
                )}
              </ul>
            )}
          </CardContent>
        </Card>
      )}

      {sendResult && (
        <Card className="glass-panel border border-emerald-500/30">
          <CardContent className="p-5">
            <p className="text-sm font-medium">
              Sent to {sendResult.sent} of {sendResult.total}
              {sendResult.failed > 0 && <span className="text-red-400"> · {sendResult.failed} failed</span>}
            </p>
            {sendResult.failed > 0 && (
              <ul className="text-xs space-y-1 mt-3">
                {sendResult.results.filter((r) => !r.ok).map((r) => (
                  <li key={r.member_id} className="text-red-400">
                    {r.email}: {r.error ?? "send returned false"}
                  </li>
                ))}
              </ul>
            )}
            <p className="text-[10px] text-muted italic mt-2">
              Anyone who failed can be re-targeted by hitting Send again with the same batch ID — successful sends are skipped.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
