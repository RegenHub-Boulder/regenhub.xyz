"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { NEWS_NOTE_COOKIE } from "@/lib/techne/newsNote";

/**
 * The one-time line after a Techne sign-in put the person on the stay-in-touch list (T-497): "We'll send you RegenHub
 * news. No thanks". Shown once: the cookie /techne/callback set is cleared as soon as the line shows. "No thanks"
 * takes them back off (POST /api/techne/newsletter); × just closes it.
 */
// Read once per page load: the cookie is cleared as soon as the line shows, and the answer must not change with it.
let pending: boolean | null = null;
const fromCookie = () => (pending ??= document.cookie.split("; ").some((c) => c === `${NEWS_NOTE_COOKIE}=1`));
const never = () => () => {};

export function NewsNote() {
  const due = useSyncExternalStore(never, fromCookie, () => false);
  const [state, setState] = useState<"shown" | "hidden" | "saving" | "declined" | "error">("shown");

  useEffect(() => {
    if (due) document.cookie = `${NEWS_NOTE_COOKIE}=; Max-Age=0; Path=/; SameSite=Lax${location.protocol === "https:" ? "; Secure" : ""}`;
  }, [due]);

  if (!due || state === "hidden") return null;

  async function decline() {
    setState("saving");
    const res = await fetch("/api/techne/newsletter", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ choice: "no" }),
    }).catch(() => null);
    setState(res?.ok ? "declined" : "error");
    if (res?.ok) setTimeout(() => setState("hidden"), 2500);
  }

  return (
    <div
      role="status"
      className="fixed inset-x-0 bottom-4 z-50 mx-auto flex w-[min(34rem,calc(100%-2rem))] items-center gap-3 rounded-md border border-ink/40 bg-sheet px-4 py-3 text-sm text-foreground shadow-[0_8px_24px_rgba(39,35,29,0.12)]"
    >
      <p className="flex-1">
        {state === "declined"
          ? "Done. We won't send you the newsletter."
          : state === "error"
            ? "Couldn't save that just now."
            : "We'll send you RegenHub news."}
      </p>
      {(state === "shown" || state === "saving" || state === "error") && (
        <button
          type="button"
          onClick={decline}
          disabled={state === "saving"}
          className="rounded-md px-2 py-1 font-medium text-sage underline underline-offset-2 hover:bg-ink/10 disabled:opacity-60"
        >
          {state === "error" ? "Try again" : "No thanks"}
        </button>
      )}
      <button
        type="button"
        aria-label="Close"
        onClick={() => setState("hidden")}
        className="rounded-md px-2 py-1 text-muted hover:bg-ink/10 hover:text-foreground"
      >
        ×
      </button>
    </div>
  );
}
