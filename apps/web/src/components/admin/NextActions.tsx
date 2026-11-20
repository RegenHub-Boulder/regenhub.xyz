"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, Clock, Loader2, Mail, RotateCcw } from "lucide-react";

/** The fields of a RecommendedAction (lib/scoreboardActions.ts) the list shows. */
export interface NextAction {
  id: string;
  kind: string;
  who: string;
  href: string | null;
  reason: string;
  step: string;
  quick?: { label: string; endpoint: string };
  contact?: string | null;
  priority: "high" | "medium" | "low";
  fingerprint: string;
}

const KIND_LABEL: Record<string, string> = {
  goal_pace_members: "Goal pace",
  goal_pace_revenue: "Goal pace",
  past_due: "Past due",
  set_to_end: "Set to end",
  left_recently: "Left recently",
  new_member: "New member",
  pass_buyer: "Day-pass buyer",
  frequent_guest: "Regular guest",
  promote_night: "Promote a night",
};

const DOT = { high: "bg-red-400", medium: "bg-amber-400", low: "bg-sage" } as const;

type Mark = "done" | "not_now" | "open";

async function mark(a: NextAction, state: Mark) {
  const res = await fetch("/api/admin/scoreboard/actions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: a.id, fingerprint: a.fingerprint, state }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? "Couldn't save that");
}

function QuickButton({ quick }: { quick: NonNullable<NextAction["quick"]> }) {
  const [state, setState] = useState<"idle" | "busy" | "sent" | string>("idle");
  return (
    <span className="inline-flex items-center gap-1">
      <button
        type="button"
        disabled={state === "busy" || state === "sent"}
        onClick={async () => {
          setState("busy");
          const res = await fetch(quick.endpoint, { method: "POST" }).catch(() => null);
          const data = await res?.json().catch(() => null);
          setState(res?.ok ? "sent" : data?.error ?? "Send failed");
        }}
        className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded btn-glass"
      >
        {state === "busy" ? <Loader2 className="w-3 h-3 animate-spin" /> : state === "sent" ? <Check className="w-3 h-3" /> : <Mail className="w-3 h-3" />}
        {state === "sent" ? "Sent" : quick.label}
      </button>
      {state !== "idle" && state !== "busy" && state !== "sent" && <span className="text-xs text-red-400">{state}</span>}
    </span>
  );
}

function Row({ a, onMark, dismissed }: { a: NextAction; onMark: (a: NextAction, s: Mark) => void; dismissed?: string }) {
  return (
    <li className="py-2.5 flex flex-col sm:flex-row sm:items-start gap-2 sm:gap-4" data-testid="next-action" data-action-id={a.id}>
      <div className="min-w-0 flex-1">
        <p className="text-sm">
          <span className={`inline-block w-1.5 h-1.5 rounded-full mr-2 align-middle ${DOT[a.priority]}`} title={`${a.priority} priority`} />
          {a.href
            ? <Link href={a.href} className="font-semibold hover:text-sage">{a.who}</Link>
            : <span className="font-semibold">{a.who}</span>}
          <span className="text-xs text-muted ml-2">{KIND_LABEL[a.kind] ?? a.kind}</span>
          {a.contact && <span className="text-xs text-muted ml-2 break-all">{a.contact}</span>}
        </p>
        <p className="text-xs text-muted mt-0.5">{a.reason}</p>
        <p className="text-sm mt-0.5">{a.step}</p>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 shrink-0">
        {dismissed ? (
          <>
            <span className="text-xs text-muted">{dismissed}</span>
            <button type="button" onClick={() => onMark(a, "open")} className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded btn-glass">
              <RotateCcw className="w-3 h-3" /> Bring back
            </button>
          </>
        ) : (
          <>
            {a.quick && <QuickButton quick={a.quick} />}
            <button type="button" onClick={() => onMark(a, "done")} className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded btn-glass">
              <Check className="w-3 h-3" /> Done
            </button>
            <button type="button" onClick={() => onMark(a, "not_now")} className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded text-muted hover:text-foreground">
              <Clock className="w-3 h-3" /> Not now
            </button>
          </>
        )}
      </div>
    </li>
  );
}

/** "What to do next": the top actions, Done / Not now (2 weeks), Show all, and the dismissed ones to bring back. */
export function NextActions({ open, hidden, top }: { open: NextAction[]; hidden: (NextAction & { mark: string })[]; top: number }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  // The last mark made here per action, so the lists move at once (before the refresh lands, and after it too).
  const [marked, setMarked] = useState<Map<string, Mark>>(new Map());
  const [all, setAll] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onMark = async (a: NextAction, state: Mark) => {
    setError(null);
    const before = marked.get(a.id);
    setMarked((m) => new Map(m).set(a.id, state));
    try {
      await mark(a, state);
      startTransition(() => router.refresh());
    } catch (e) {
      setMarked((m) => {
        const next = new Map(m);
        if (before) next.set(a.id, before);
        else next.delete(a.id);
        return next;
      });
      setError(e instanceof Error ? e.message : "Couldn't save that");
    }
  };

  const isOpen = (id: string, fallback: boolean) => (marked.has(id) ? marked.get(id) === "open" : fallback);
  const list = [...open, ...hidden].filter((a) => isOpen(a.id, open.includes(a)));
  const shown = all ? list : list.slice(0, top);
  const back = hidden.filter((a) => !isOpen(a.id, false)).concat(
    open.filter((a) => !isOpen(a.id, true)).map((a) => ({ ...a, mark: marked.get(a.id)! })),
  );

  return (
    <div>
      {error && <p className="text-xs text-red-400 mb-2">{error}</p>}
      {list.length === 0 ? (
        <p className="text-sm text-muted">Nothing needs doing right now.</p>
      ) : (
        <ul className="divide-y divide-white/5">
          {shown.map((a) => <Row key={a.id} a={a} onMark={onMark} />)}
        </ul>
      )}
      <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-xs text-muted">
        {list.length > top && (
          <button type="button" onClick={() => setAll(!all)} className="hover:text-foreground">
            {all ? `Show the top ${top}` : `Show all ${list.length}`}
          </button>
        )}
        {back.length > 0 && (
          <button type="button" onClick={() => setShowHidden(!showHidden)} className="hover:text-foreground">
            {showHidden ? "Hide dismissed" : `${back.length} dismissed`}
          </button>
        )}
        {pending && <Loader2 className="w-3 h-3 animate-spin" />}
      </div>
      {showHidden && back.length > 0 && (
        <ul className="divide-y divide-white/5 mt-2 opacity-70">
          {back.map((a) => <Row key={a.id} a={a} onMark={onMark} dismissed={a.mark === "done" ? "Done" : "Not now"} />)}
        </ul>
      )}
    </div>
  );
}
