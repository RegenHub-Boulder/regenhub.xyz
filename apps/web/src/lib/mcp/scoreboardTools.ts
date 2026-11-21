import type { McpAuthInfo } from "./oauth";
import { fail, scopeDenied, text, type ToolResult } from "./billingTools";
import type { createServiceClient } from "@/lib/supabase/admin";
import { readScoreboard, type Scoreboard } from "@/lib/scoreboardData";
import { SCOREBOARD_GOALS, headlineText, usd } from "@/lib/scoreboard";
import type { RecommendedAction } from "@/lib/scoreboardActions";
import { ACTION_KIND_LABEL } from "@/lib/scoreboardActionKinds";

/**
 * The MCP's scoreboard tools (T-497): the numbers and the recommended actions /admin/scoreboard shows, so Uni can
 * prepare the every-other-Wednesday numbers itself. Read-only, `read` scope, gated like billing_summary. Both read
 * through readScoreboard (lib/scoreboardData.ts), so every number has the one definition the page uses. No email
 * addresses or payment details in the text: people are named, with their member id.
 */

type ServiceClient = ReturnType<typeof createServiceClient>;

const signed = (n: number) => (n > 0 ? `+${n}` : `${n}`);

async function read(admin: ServiceClient): Promise<Scoreboard | ToolResult> {
  try {
    return await readScoreboard(admin);
  } catch (e) {
    return fail(`Couldn't read the scoreboard: ${e instanceof Error ? e.message : String(e)}`);
  }
}
const isResult = (x: Scoreboard | ToolResult): x is ToolResult => "content" in x;

/** `scoreboard_summary` — headline numbers, goal pace, subscriptions and funnel by month, event turnout. */
export async function scoreboardSummaryHandler(admin: ServiceClient, auth: McpAuthInfo): Promise<ToolResult> {
  const denied = scopeDenied(auth, "scoreboard_summary", "read");
  if (denied) return denied;
  const s = await read(admin);
  if (isResult(s)) return s;
  const { goal, pace } = s;
  const lines = [
    "## Scoreboard",
    headlineText({ today: s.today, goal, flow: s.flow, funnel: s.funnel, pool: s.pool, newsletter: s.newsletter }),
    "",
    `### Goal pace (straight line from ${SCOREBOARD_GOALS.baselineDate} to ${SCOREBOARD_GOALS.goalDate}, ${Math.round(pace.elapsed * 100)}% of the way)`,
    `Members: ${goal.payingMembers} now, ${pace.expectedMembers.toFixed(1)} on the line today (` +
      (pace.membersBehind > 0 ? `${pace.membersBehind.toFixed(1)} behind` : `${(-pace.membersBehind).toFixed(1)} ahead`) +
      `); ${pace.membersNeededFortnight} more in the next two weeks keeps pace.`,
    `Revenue: ${usd(goal.revenue.netCents)}/mo net now, ${usd(pace.expectedNetCents)} on the line today (` +
      (pace.netBehindCents > 0 ? `${usd(pace.netBehindCents)} behind` : `${usd(-pace.netBehindCents)} ahead`) +
      `); ${usd(pace.netNeededFortnightCents)}/mo more in the next two weeks keeps pace.`,
    "",
    "### Subscriptions per month (card and USDC; a cancellation counts in the month it ended)",
    "| month | new | cancelled | net |",
    "|---|---|---|---|",
    ...s.flow.map((m) => `| ${m.month} | ${m.started} | ${m.canceled} | ${signed(m.net)} |`),
    "",
    "### Funnel per month",
    "| month | stay-in-touch | applications | day passes | first subscriptions |",
    "|---|---|---|---|---|",
    ...s.funnel.map((m) => `| ${m.month} | ${m.signups} | ${m.applications} | ${m.passesBought} | ${m.firstSubscriptions} |`),
    "",
    "### Event turnout (RSVPs going, on Techne; upcoming and the last 60 days)",
  ];
  if (s.turnout == null) lines.push("The Techne calendar isn't configured or couldn't be read.");
  else if (s.turnout.length === 0) lines.push("No events in this window.");
  else {
    for (const g of s.turnout) {
      lines.push(`**${g.series}**` + (g.past.length > 0 ? ` — ${g.pastGoing} going over ${g.past.length} past` : ""));
      for (const e of [...g.upcoming, ...[...g.past].reverse()]) {
        lines.push(`- ${e.startAt ? e.startAt.slice(0, 10) : "—"} ${e.name}: ${e.going == null ? "?" : `${e.going} going`}` +
          (g.upcoming.includes(e) ? " (upcoming)" : ""));
      }
    }
  }
  lines.push("", `Open recommended actions: ${s.actions.open.length} (recommended_actions lists them).`);
  return text(lines.join("\n"));
}

function actionLines(a: RecommendedAction, n: number, mark?: string): string[] {
  return [
    `${n}. [${a.priority}] ${a.who}${a.memberId != null ? ` (member ${a.memberId})` : ""} — ${ACTION_KIND_LABEL[a.kind].toLowerCase()}${mark ? ` — ${mark}` : ""}`,
    `   Why: ${a.reason}`,
    `   Step: ${a.step}`,
    `   id: ${a.id}`,
  ];
}

/** `recommended_actions` — the open "what to do next" list, ranked; optionally the dismissed ones. */
export async function recommendedActionsHandler(
  admin: ServiceClient, auth: McpAuthInfo, args: { limit?: number; include_dismissed?: boolean },
): Promise<ToolResult> {
  const denied = scopeDenied(auth, "recommended_actions", "read");
  if (denied) return denied;
  const s = await read(admin);
  if (isResult(s)) return s;
  const limit = args.limit ?? 20;
  const { open, hidden } = s.actions;
  const lines = [
    `## What to do next, ${s.today}`,
    `${open.length} open${hidden.length > 0 ? `, ${hidden.length} dismissed (Done, or Not now for two weeks)` : ""}. ` +
      "Ranked by goal impact, then urgency. Mark them Done or Not now on /admin (Today, the admin home).",
    "",
  ];
  if (open.length === 0) lines.push("Nothing needs doing right now.");
  open.slice(0, limit).forEach((a, i) => lines.push(...actionLines(a, i + 1)));
  if (open.length > limit) lines.push("", `…and ${open.length - limit} more (raise limit to see them).`);
  if (args.include_dismissed && hidden.length > 0) {
    lines.push("", "### Dismissed");
    hidden.forEach((a, i) => lines.push(...actionLines(a, i + 1, a.mark.state === "done" ? "done" : "not now")));
  }
  return text(lines.join("\n"));
}

export const SCOREBOARD_DESCRIPTIONS = {
  scoreboard_summary:
    "Read-only. The co-op scoreboard (/admin/scoreboard) as text: paying members ($30+/mo plans) and net membership revenue against the " +
    "goals (net +10 members and $2,750/mo by 2027-01-20), pace against the straight line to the goal, subscriptions started and cancelled per " +
    "month, the funnel per month (stay-in-touch signups, applications, day passes, first subscriptions), event turnout from Techne by series, " +
    "and the newsletter list. Same definitions as the page, the admin dashboard and billing_summary. No names or contact details.",
  recommended_actions:
    "Read-only. The scoreboard's \"what to do next\" list, ranked by goal impact then urgency: past-due members (send the reminder), members " +
    "set to end (talk first), people who left in the last 90 days (a personal note), new members (welcome), day-pass buyers and regular " +
    "guests who never joined (invite), thin upcoming nights (promote), and goal pace. Each has who (name and member id, never an email), " +
    "why (the fact behind it), the step and a stable id. Actions an admin marked Done or Not now are left out unless include_dismissed.",
} as const;
