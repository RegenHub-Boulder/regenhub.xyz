"use client";

/**
 * The roster on /admin/stewards for RegenHub's facilitators and managers: everyone holding a role on Techne, with
 * change and end, and an add form (a Techne handle and a role). Each action is one POST /api/techne/stewards, which
 * reads the roster again, checks the caller's role and writes as RegenHub; Techne's or the server's refusal shows
 * above the list in its own words.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { ROLES, roleName } from "@/lib/techne/roles";

export interface RosterRow {
  did: string;
  /** `@handle` when it is verified both ways, else the short DID. */
  label: string;
  role: number;
  since: string | null;
}

/** The offered role a held role sits at (a lexicon "member" 10 shows as member 20's choice). */
const offered = (role: number) => (role >= 40 ? 40 : role >= 30 ? 30 : 20);
const day = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/Denver" }) : null;

const selectClass = "rounded-md border border-rule bg-ink/10 px-2 py-1.5 text-sm text-foreground";

export function StewardRoster({ rows, me }: { rows: RosterRow[]; me: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [handle, setHandle] = useState("");
  const [addRole, setAddRole] = useState(20);
  const [picked, setPicked] = useState<Record<string, number>>({});

  async function send(key: string, body: Record<string, unknown>, success: string) {
    setBusy(key);
    setError(null);
    setDone(null);
    try {
      const res = await fetch("/api/techne/stewards", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const out = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !out.ok) {
        setError(out.error ?? "Couldn't tell whether Techne took that. Reload to see the list before trying again.");
        return false;
      }
      setDone(success);
      router.refresh();
      return true;
    } catch {
      setError("Couldn't reach this site. Reload to see the list before trying again.");
      return false;
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-6 max-w-3xl">
      {error && (
        <p className="text-sm text-danger" role="alert" data-testid="stewards-error">
          {error}
        </p>
      )}
      {done && (
        <p className="text-sm text-sage" role="status" data-testid="stewards-done">
          {done}
        </p>
      )}

      <form
        className="glass-panel p-5 flex flex-wrap items-end gap-3"
        data-testid="stewards-add"
        onSubmit={async (e) => {
          e.preventDefault();
          const h = handle.trim().replace(/^@/, "");
          if (await send("add", { op: "add", handle: h, role: addRole }, `Added @${h} as ${roleName(addRole)}.`)) setHandle("");
        }}
      >
        <label className="flex-1 min-w-[12rem] space-y-1 text-sm">
          <span className="text-muted">Techne handle</span>
          <input
            id="steward-handle"
            className="w-full rounded-md border border-rule bg-ink/10 px-3 py-1.5 text-sm text-foreground"
            placeholder="name.techne.town"
            autoComplete="off"
            value={handle}
            onChange={(e) => setHandle(e.target.value)}
          />
        </label>
        <label className="space-y-1 text-sm">
          <span className="text-muted block">Role</span>
          <select id="steward-add-role" className={selectClass} value={addRole} onChange={(e) => setAddRole(Number(e.target.value))}>
            {ROLES.map((r) => (
              <option key={r.role} value={r.role}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
        <Button type="submit" className="btn-primary-glass" disabled={!!busy || !handle.trim()}>
          {busy === "add" ? "Adding…" : "Add"}
        </Button>
      </form>

      <ul className="glass-panel divide-y divide-rule" data-testid="stewards-list">
        {rows.map((r) => {
          const choice = picked[r.did] ?? offered(r.role);
          const changed = choice !== offered(r.role);
          return (
            <li key={r.did} className="p-4 flex flex-wrap items-center gap-3" data-testid="steward-row" data-did={r.did}>
              <div className="flex-1 min-w-[10rem]">
                <code className="text-foreground" title={r.did}>
                  {r.label}
                </code>
                {r.did === me && <span className="ml-2 text-xs text-muted">(you)</span>}
                <div className="text-xs text-muted">
                  <span data-testid="steward-role">{roleName(r.role)}</span>
                  {day(r.since) ? ` · since ${day(r.since)}` : ""}
                </div>
              </div>
              <select
                aria-label={`Role for ${r.label}`}
                className={selectClass}
                value={choice}
                disabled={!!busy}
                onChange={(e) => setPicked({ ...picked, [r.did]: Number(e.target.value) })}
              >
                {ROLES.map((x) => (
                  <option key={x.role} value={x.role}>
                    {x.name}
                  </option>
                ))}
              </select>
              {changed && (
                <Button
                  type="button"
                  size="sm"
                  disabled={!!busy}
                  onClick={async () => {
                    if (await send(r.did, { op: "change", did: r.did, role: choice }, `${r.label} is now ${roleName(choice)}.`)) {
                      setPicked((p) => Object.fromEntries(Object.entries(p).filter(([k]) => k !== r.did)));
                    }
                  }}
                >
                  {busy === r.did ? "Saving…" : "Save"}
                </Button>
              )}
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="text-muted hover:text-danger"
                disabled={!!busy}
                onClick={() => {
                  if (!window.confirm(`End ${r.label}'s role in RegenHub? Their claim gets an end date; what they did while they held it still counts.`)) return;
                  void send(`end:${r.did}`, { op: "end", did: r.did }, `${r.label} no longer holds a role in RegenHub.`);
                }}
              >
                {busy === `end:${r.did}` ? "Ending…" : "End role"}
              </Button>
            </li>
          );
        })}
      </ul>
      <p className="text-xs text-muted leading-relaxed">
        Facilitators and managers manage RegenHub on Techne: they post its events and change these roles. RegenHub always
        keeps at least one. Ending a role sets an end date on Techne; nothing is deleted.
      </p>
    </div>
  );
}
