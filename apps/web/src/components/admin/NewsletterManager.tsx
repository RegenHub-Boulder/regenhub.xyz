"use client";

import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { Plus, FileText, CheckCircle2, Send as SendIcon } from "lucide-react";
import { NewsletterStudio } from "./NewsletterStudio";

interface Issue {
  id: number;
  issue_key: string;
  subject: string;
  markdown_body: string | null;
  status: string;
  created_at: string | null;
  updated_at: string | null;
  recipients_count: number;
  sent_count: number;
}

// Client-side mirror of issueKeyFor() — the ISO-week anchor used for the
// public /news/[key] URL and auto-send idempotency.
function isoWeekKey(d: Date): string {
  const dt = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((dt.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${dt.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

// A new draft anchors to the current ISO week; if that key is taken (already
// drafted/sent this week) we suffix it so a fresh draft never collides.
function freshKey(existing: Set<string>): string {
  const base = isoWeekKey(new Date());
  if (!existing.has(base)) return base;
  for (let n = 2; ; n++) {
    const k = `${base}-${n}`;
    if (!existing.has(k)) return k;
  }
}

function fmtDate(s: string | null): string {
  if (!s) return "";
  return new Date(s).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function StatusBadge({ issue }: { issue: Issue }) {
  if (issue.status === "sent") {
    const detail = issue.recipients_count > 0 ? ` · ${issue.sent_count}/${issue.recipients_count}` : "";
    return <span className="inline-flex items-center gap-1 text-[11px] text-emerald-400"><CheckCircle2 className="w-3 h-3" />Sent{detail}</span>;
  }
  if (issue.status === "sending") {
    return <span className="inline-flex items-center gap-1 text-[11px] text-amber-400"><SendIcon className="w-3 h-3" />Sending</span>;
  }
  return <span className="inline-flex items-center gap-1 text-[11px] text-muted"><FileText className="w-3 h-3" />Draft</span>;
}

export function NewsletterManager({ initialIssues }: { initialIssues: Issue[] }) {
  const [issues, setIssues] = useState<Issue[]>(initialIssues);
  // Land on the most-recent unsent issue (actionable work), else the latest, else a new draft.
  const [selectedId, setSelectedId] = useState<number | "new">(() => {
    const draft = initialIssues.find((i) => i.status !== "sent");
    return draft?.id ?? initialIssues[0]?.id ?? "new";
  });
  const [seedKey, setSeedKey] = useState<string>(() => freshKey(new Set(initialIssues.map((i) => i.issue_key))));

  const refresh = useCallback(async (selectId?: number) => {
    try {
      const res = await fetch("/api/admin/newsletter/list");
      const d = await res.json();
      if (Array.isArray(d.issues)) setIssues(d.issues);
      if (selectId) setSelectedId(selectId);
    } catch { /* ignore */ }
  }, []);

  function newDraft() {
    setSeedKey(freshKey(new Set(issues.map((i) => i.issue_key))));
    setSelectedId("new");
  }

  const selected = typeof selectedId === "number" ? issues.find((i) => i.id === selectedId) ?? null : null;
  const studioDraft =
    selectedId === "new"
      ? { id: null, issue_key: seedKey, subject: "", markdown_body: "", status: "draft" }
      : selected
        ? { id: selected.id, issue_key: selected.issue_key, subject: selected.subject, markdown_body: selected.markdown_body, status: selected.status }
        : null;
  // Remount the studio on selection change so its internal editor state resets.
  const studioKey = selectedId === "new" ? `new-${seedKey}` : `issue-${selectedId}`;

  return (
    <div className="grid lg:grid-cols-[260px_1fr] gap-6 items-start">
      {/* Issue list */}
      <aside className="space-y-2 lg:sticky lg:top-24">
        <Button onClick={newDraft} className="btn-primary-glass w-full text-xs gap-1.5 h-9">
          <Plus className="w-3.5 h-3.5" /> New draft
        </Button>
        <div className="space-y-1.5 max-h-[70vh] overflow-auto pr-1">
          {selectedId === "new" && (
            <div className="rounded-lg border border-sage/40 bg-white/5 px-3 py-2.5 text-left">
              <div className="text-sm font-medium text-foreground truncate">Untitled draft</div>
              <div className="flex items-center justify-between mt-1">
                <span className="text-[11px] text-muted font-mono">{seedKey}</span>
                <StatusBadge issue={{ status: "draft" } as Issue} />
              </div>
            </div>
          )}
          {issues.map((i) => {
            const active = i.id === selectedId;
            return (
              <button
                key={i.id}
                onClick={() => setSelectedId(i.id)}
                className={`w-full rounded-lg border px-3 py-2.5 text-left transition-colors ${
                  active ? "border-sage/50 bg-white/10" : "border-white/10 hover:bg-white/5"
                }`}
              >
                <div className="text-sm font-medium text-foreground truncate">{i.subject || "Untitled"}</div>
                <div className="flex items-center justify-between mt-1 gap-2">
                  <span className="text-[11px] text-muted truncate">{fmtDate(i.created_at) || i.issue_key}</span>
                  <StatusBadge issue={i} />
                </div>
              </button>
            );
          })}
          {issues.length === 0 && selectedId !== "new" && (
            <p className="text-xs text-muted px-1 py-2">No issues yet — start a new draft.</p>
          )}
        </div>
      </aside>

      {/* Editor */}
      <div className="min-w-0">
        {studioDraft ? (
          <NewsletterStudio key={studioKey} initialDraft={studioDraft} onMutate={(id) => refresh(id)} />
        ) : (
          <p className="text-sm text-muted">Select an issue from the list, or start a new draft.</p>
        )}
      </div>
    </div>
  );
}
