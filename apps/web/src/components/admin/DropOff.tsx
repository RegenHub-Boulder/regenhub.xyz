import { DOORS, STEP_LABEL, leakNotes, type DoorFunnel, type LeakFunnels, type StepKey } from "@/lib/leakFunnel";

/**
 * "Where people drop off" on /admin/scoreboard (T-497): one row per way in, each step a count with its % of the step
 * before and of the start, the biggest drop named above. Counts only (no names), so it reads the same in the CSV.
 */
const COLUMNS: StepKey[] = ["pass", "came_in", "joined", "renewed1", "renewed2", "renewed3"];
const SHORT: Record<StepKey, string> = {
  pass: "Got a pass",
  came_in: "Came in",
  joined: "Joined",
  renewed1: "2nd month",
  renewed2: "3rd month",
  renewed3: "4th month",
};

const monthLong = (key: string) =>
  new Date(`${key}-15T12:00:00Z`).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
const pct = (n: number | null) => (n == null ? "–" : `${n}%`);

function StepCell({ d, k, biggest }: { d: DoorFunnel; k: StepKey; biggest: boolean }) {
  const s = d.steps.find((x) => x.key === k);
  if (!s) return <td className="py-1.5 px-2 text-right text-muted">·</td>;
  return (
    <td className={`py-1.5 px-2 text-right ${biggest ? "bg-tint" : ""}`} data-step={k}>
      <span className={biggest ? "text-warn font-semibold" : ""}>{s.count}</span>
      <span className="block text-[11px] text-muted whitespace-nowrap">{pct(s.ofPrev)} · {pct(s.ofStart)}</span>
    </td>
  );
}

function Cohorts({ d }: { d: DoorFunnel }) {
  const keys = COLUMNS.filter((k) => d.steps.some((s) => s.key === k));
  return (
    <div className="overflow-x-auto">
      <p className="text-xs font-semibold mt-3 mb-1">{d.label}</p>
      <table className="text-sm tabular-nums border-collapse" data-testid={`cohorts-${d.door}`}>
        <thead>
          <tr className="text-xs text-muted border-b border-rule">
            <th className="py-1 pr-3 text-left font-medium">Started</th>
            <th className="py-1 px-2 text-right font-medium">People</th>
            {keys.map((k) => <th key={k} className="py-1 px-2 text-right font-medium">{SHORT[k]}</th>)}
          </tr>
        </thead>
        <tbody>
          {d.cohorts.map((c) => (
            <tr key={c.month} className="border-b border-rule" data-month={c.month}>
              <th scope="row" className="py-1 pr-3 text-left font-normal whitespace-nowrap">{monthLong(c.month)}</th>
              <td className="py-1 px-2 text-right">{c.started}</td>
              {c.steps.map((s) => (
                <td key={s.key} className={`py-1 px-2 text-right ${s.tooEarly ? "text-muted" : ""}`}>
                  {c.started === 0 ? "·" : s.count}
                  {s.tooEarly && c.started > 0 && <span className="block text-[11px] whitespace-nowrap">too early</span>}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function DropOff({ leaks }: { leaks: LeakFunnels }) {
  const used = COLUMNS.filter((k) => leaks.doors.some((d) => d.steps.some((s) => s.key === k)));
  const noRow = leaks.doors.filter((d) => d.read && d.noMemberRow > 0);
  const already = leaks.doors.filter((d) => d.read && d.alreadyMembers > 0);
  return (
    <div data-testid="drop-off">
      <p className="text-base mb-3" data-testid="biggest-drop">
        {leaks.biggest ? leaks.biggest.sentence : "No drop to name yet: nobody's window has closed."}
      </p>
      <div className="overflow-x-auto">
        <table className="text-sm tabular-nums border-collapse w-full">
          <thead>
            <tr className="text-xs text-muted border-b border-rule">
              <th className="py-1.5 pr-3 text-left font-medium">Way in</th>
              <th className="py-1.5 px-2 text-right font-medium">People</th>
              {used.map((k) => <th key={k} className="py-1.5 px-2 text-right font-medium align-bottom" title={STEP_LABEL[k]}>{SHORT[k]}</th>)}
            </tr>
          </thead>
          <tbody>
            {leaks.doors.map((d) => (
              <tr key={d.door} className="border-b border-rule align-top" data-door={d.door}>
                <th scope="row" className="py-1.5 pr-3 text-left font-medium">{d.label}</th>
                {d.read ? (
                  <>
                    <td className="py-1.5 px-2 text-right font-semibold">{d.started}</td>
                    {used.map((k) => (
                      <StepCell key={k} d={d} k={k} biggest={leaks.biggest?.door === d.door && leaks.biggest.step === k} />
                    ))}
                  </>
                ) : (
                  <td colSpan={used.length + 1} className="py-1.5 px-2 text-xs text-muted">Couldn&apos;t read these rows right now.</td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted mt-2">
        Under each count: % of the step before · % of the start. A step counts everyone who got at least that far.
        {already.length > 0 && <> Already members when they came through, not counted: {already.map((d) => `${d.alreadyMembers} ${DOOR_SHORT[d.door]}`).join(", ")}.</>}
        {noRow.length > 0 && <> No member row, so counted at the start only: {noRow.map((d) => `${d.noMemberRow} ${DOOR_SHORT[d.door]}`).join(", ")}.</>}
      </p>
      <details className="mt-3" data-testid="drop-off-months">
        <summary className="text-xs text-muted cursor-pointer hover:text-foreground">By month started</summary>
        {leaks.doors.filter((d) => d.read && d.cohorts.length > 0).map((d) => <Cohorts key={d.door} d={d} />)}
      </details>
      <details className="mt-2" data-testid="drop-off-notes">
        <summary className="text-xs text-muted cursor-pointer hover:text-foreground">How these are counted</summary>
        <ol className="mt-2 space-y-1 text-xs text-muted list-decimal pl-4">
          {leakNotes(leaks.cardPeriods).map((n) => <li key={n}>{n}</li>)}
        </ol>
      </details>
    </div>
  );
}

const DOOR_SHORT: Record<(typeof DOORS)[number]["key"], string> = {
  free_day: "free days",
  day_pass: "pass buyers",
  gifted: "given passes",
  rsvp: "RSVPs",
};
