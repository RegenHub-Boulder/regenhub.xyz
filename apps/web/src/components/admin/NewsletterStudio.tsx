"use client";

import { useEffect, useRef, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Loader2, Save, Eye, Users, Send, RotateCcw, DownloadCloud, Square } from "lucide-react";
import { markdownToEmailHtml } from "@/lib/newsletterMarkdown";

interface Draft {
  id: number;
  issue_key: string;
  subject: string;
  markdown_body: string | null;
  status: string;
}
interface Progress {
  total: number;
  sent: number;
  failed: number;
  pending: number;
  done: boolean;
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: unknown = null;
  if (text) { try { data = JSON.parse(text); } catch { /* keep null */ } }
  if (!res.ok) throw new Error((data as { error?: string })?.error ?? `HTTP ${res.status}`);
  return data as T;
}

export function NewsletterStudio({ initialDraft }: { initialDraft: Draft | null }) {
  const [subject, setSubject] = useState(initialDraft?.subject ?? "");
  const [markdown, setMarkdown] = useState(initialDraft?.markdown_body ?? "");
  const [issueId, setIssueId] = useState<number | null>(initialDraft?.id ?? null);
  const [status, setStatus] = useState(initialDraft?.status ?? "draft");
  const [issueKey] = useState(initialDraft?.issue_key ?? null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [showPreview, setShowPreview] = useState(false);

  const [busy, setBusy] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const stopRef = useRef(false);

  const sent = status === "sent";

  // On open, load the current send progress for an existing issue so a
  // partially-sent / reopened issue shows its real state (and Resume/Retry work)
  // without first having to click Prepare.
  useEffect(() => {
    if (initialDraft?.id) void refreshStatus(initialDraft.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function saveDraft(): Promise<number | null> {
    setBusy("save"); setErr(null); setMsg(null);
    try {
      const d = await api<{ draft: Draft }>("/api/admin/newsletter/draft", { subject, markdown, issue_key: issueKey });
      setIssueId(d.draft.id); setStatus(d.draft.status); setMsg("Draft saved.");
      return d.draft.id;
    } catch (e) { setErr(errMessage(e)); return null; }
    finally { setBusy(null); }
  }

  async function preview() {
    setBusy("preview"); setErr(null); setMsg(null);
    try {
      const r = await api<{ ok: boolean; sent_to: string }>("/api/admin/newsletter/preview", { subject, markdown, issue_key: issueKey });
      setMsg(r.ok ? `Preview sent to ${r.sent_to}.` : "Preview failed to send (check email config).");
    } catch (e) { setErr(errMessage(e)); }
    finally { setBusy(null); }
  }

  async function importLuma() {
    setBusy("luma"); setErr(null); setMsg(null);
    try {
      const r = await api<{ fetched: number; imported: number; skipped: number; note?: string }>("/api/admin/newsletter/import-luma");
      setMsg(r.note ?? `Luma: ${r.imported} new contacts added, ${r.skipped} already on the list (of ${r.fetched}).`);
    } catch (e) { setErr(errMessage(e)); }
    finally { setBusy(null); }
  }

  async function refreshStatus(id: number) {
    try {
      const res = await fetch(`/api/admin/newsletter/status?issue_id=${id}`);
      const d = await res.json();
      if (d.progress) setProgress(d.progress);
      if (d.issue?.status) setStatus(d.issue.status);
    } catch { /* ignore */ }
  }

  async function prepare() {
    let id = issueId;
    if (!id) { id = await saveDraft(); if (!id) return; }
    setBusy("prepare"); setErr(null); setMsg(null);
    try {
      const r = await api<{ total: number }>("/api/admin/newsletter/prepare", { issue_id: id });
      setMsg(`Audience ready: ${r.total} recipient${r.total === 1 ? "" : "s"}.`);
      await refreshStatus(id);
    } catch (e) { setErr(errMessage(e)); }
    finally { setBusy(null); }
  }

  async function runSend(retry = false) {
    let id = issueId;
    if (!id) { id = await saveDraft(); if (!id) return; }
    if (!progress?.total) { setErr("Prepare the audience first."); return; }
    if (!retry) {
      // Only the not-yet-sent recipients actually go out (the ledger skips sent ones).
      const toSend = progress.pending + progress.failed;
      const ok = window.confirm(`Send "${subject}" to ${toSend} recipient${toSend === 1 ? "" : "s"}? This goes to real inboxes (already-sent are skipped).`);
      if (!ok) return;
    }
    setErr(null); setMsg(null); setSending(true); stopRef.current = false;
    try {
      let first = true;
      // Loop one batch at a time until the ledger is drained (or stopped).
      // Each batch self-paces (rate-limit back-off lives server-side).
      while (!stopRef.current) {
        const r = await api<{ processed: number; quotaReached?: boolean; progress: Progress }>(
          "/api/admin/newsletter/send",
          { issue_id: id, retry_failed: first && retry },
        );
        first = false;
        setProgress(r.progress);
        if (r.quotaReached) {
          setErr(`⏸ Daily email quota reached — ${r.progress.sent}/${r.progress.total} delivered. Already-sent are saved; come back and click Send to resume once the quota resets or your Resend plan is bumped.`);
          break;
        }
        if (r.progress.done) { setStatus("sent"); setMsg("All recipients processed. 🎉"); break; }
        if (r.processed === 0) { setMsg("Nothing left to send."); break; }
      }
      if (stopRef.current) setMsg("Paused. Click Send to resume — already-sent recipients are skipped.");
    } catch (e) { setErr(errMessage(e)); }
    finally { setSending(false); }
  }

  const pct = progress && progress.total > 0
    ? Math.round(((progress.sent + progress.failed) / progress.total) * 100)
    : 0;

  return (
    <div className="space-y-5">
      {/* Compose */}
      <Card className="glass-panel border border-sage/20">
        <CardContent className="p-5 space-y-3">
          <h3 className="text-sm font-semibold">Compose {issueKey ? <span className="text-muted font-normal">· {issueKey}</span> : null}{sent ? <span className="text-emerald-400 font-normal"> · sent</span> : null}</h3>
          <div>
            <label className="text-xs text-muted">Subject</label>
            <input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              disabled={sent}
              className="w-full mt-1 px-3 py-2 rounded-md bg-black/20 border border-white/10 text-sm"
              placeholder="RegenHub dispatch — …"
            />
          </div>
          <div>
            <label className="text-xs text-muted">Body (Markdown)</label>
            <textarea
              value={markdown}
              onChange={(e) => setMarkdown(e.target.value)}
              disabled={sent}
              rows={16}
              className="w-full mt-1 px-3 py-2 rounded-md bg-black/20 border border-white/10 text-sm font-mono leading-relaxed"
              placeholder="## News from the cooperative&#10;&#10;Hi friends, …"
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={!!busy || sent} onClick={saveDraft} className="btn-glass text-xs gap-1 h-7">
              {busy === "save" ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />} Save draft
            </Button>
            <Button size="sm" disabled={!!busy} onClick={() => setShowPreview((v) => !v)} className="btn-glass text-xs gap-1 h-7">
              <Eye className="w-3 h-3" /> {showPreview ? "Hide" : "Show"} preview
            </Button>
            <Button size="sm" disabled={!!busy || !markdown} onClick={preview} className="btn-glass text-xs gap-1 h-7">
              {busy === "preview" ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />} Email preview to me
            </Button>
          </div>
          {showPreview && (
            <div className="mt-2 rounded-md border border-white/10 bg-white p-5 max-h-[520px] overflow-auto">
              <div
                style={{
                  color: "#1a1a1a",
                  fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
                  lineHeight: 1.55,
                }}
                dangerouslySetInnerHTML={{ __html: markdownToEmailHtml(markdown) }}
              />
            </div>
          )}
        </CardContent>
      </Card>

      {/* Audience */}
      <Card className="glass-panel border border-sage/20">
        <CardContent className="p-5 space-y-3">
          <div className="flex items-center gap-2"><Users className="w-4 h-4 text-sage" /><h3 className="text-sm font-semibold">Audience</h3></div>
          <p className="text-xs text-muted">
            Recipients = members + the interests list (incl. imported Luma contacts) − unsubscribes.
            Importing Luma adds new calendar people to the interests list with one-click unsubscribe.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={!!busy || sent} onClick={importLuma} className="btn-glass text-xs gap-1 h-7">
              {busy === "luma" ? <Loader2 className="w-3 h-3 animate-spin" /> : <DownloadCloud className="w-3 h-3" />} Import Luma contacts
            </Button>
            <Button size="sm" disabled={!!busy || sent} onClick={prepare} className="btn-glass text-xs gap-1 h-7">
              {busy === "prepare" ? <Loader2 className="w-3 h-3 animate-spin" /> : <Users className="w-3 h-3" />} Prepare audience
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Send */}
      <Card className="glass-panel border border-sage/20">
        <CardContent className="p-5 space-y-3">
          <div className="flex items-center gap-2"><Send className="w-4 h-4 text-sage" /><h3 className="text-sm font-semibold">Send</h3></div>

          {progress && (
            <div className="space-y-1.5">
              <div className="h-2 w-full rounded-full bg-white/10 overflow-hidden">
                <div className="h-full bg-emerald-500 transition-all" style={{ width: `${pct}%` }} />
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted">
                <span className="text-emerald-400">✓ {progress.sent} sent</span>
                <span>{progress.pending} pending</span>
                {progress.failed > 0 && <span className="text-red-400">{progress.failed} failed</span>}
                <span>of {progress.total}</span>
                {sending && <span className="text-sage">· sending…</span>}
              </div>
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            {!sending ? (
              <Button size="sm" disabled={!!busy || sent || !progress?.total} onClick={() => runSend(false)} className="btn-glass text-xs gap-1 h-7">
                <Send className="w-3 h-3" /> Send to all
              </Button>
            ) : (
              <Button size="sm" onClick={() => { stopRef.current = true; }} className="btn-glass text-xs gap-1 h-7">
                <Square className="w-3 h-3" /> Pause
              </Button>
            )}
            {progress && progress.failed > 0 && !sending && (
              <Button size="sm" disabled={!!busy} onClick={() => runSend(true)} className="btn-glass text-xs gap-1 h-7">
                <RotateCcw className="w-3 h-3" /> Retry {progress.failed} failed
              </Button>
            )}
          </div>
          {sent && <p className="text-xs text-emerald-400">This issue is marked sent. Compose a new draft for the next one.</p>}
        </CardContent>
      </Card>

      {msg && <p className="text-xs text-sage">{msg}</p>}
      {err && <p className="text-xs text-red-400">{err}</p>}
    </div>
  );
}
