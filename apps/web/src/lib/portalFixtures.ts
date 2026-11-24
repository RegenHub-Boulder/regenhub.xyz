import { PLACEHOLDER_CODE, type PortalHomeView, type PortalMember, type PortalSubscription } from "@/lib/portalHome";
import { PLANS } from "@/lib/plans";

/**
 * The kinds of member an admin can view the portal as (lib/viewAs.ts, /admin/view-as). Each is a fictional member
 * built here in memory: no database rows, no reads, no real names, emails or codes (any door code is
 * PLACEHOLDER_CODE). Add a kind = add an entry; the picker and the tests read this list.
 */

export interface PortalFixture {
  key: string;
  /** How the bar names it: "Viewing as: {label}". */
  label: string;
  /** One line under it on the picker: what this state shows. */
  shows: string;
  /** What the portal frame needs: the passes link's name, and whether Events shows (a Techne steward of RegenHub). */
  nav: { memberType: string | null; steward: boolean };
  view(nowMs: number): PortalHomeView;
}

const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();
const boulderDate = (ms: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Denver" }).format(new Date(ms));

function member(nowMs: number, over: Partial<PortalMember> & Pick<PortalMember, "name" | "member_type">): PortalMember {
  return {
    id: 0,
    pin_code: null,
    created_at: iso(nowMs - 400 * DAY),
    is_coop_member: false,
    is_admin: false,
    disabled: false,
    day_passes_balance: 0,
    approved: false,
    desk_access: false,
    desk_asked_at: null,
    profile_photo_url: null,
    bio: "Sample member for the portal preview.",
    telegram_username: "@sample",
    show_in_directory: false,
    ...over,
  };
}

function plan(nowMs: number, planKey: keyof typeof PLANS, over: Partial<PortalSubscription> = {}): PortalSubscription {
  const cents = PLANS[planKey].defaultMonthlyCents;
  return {
    id: 0,
    plan_key: planKey,
    payment_rail: "stripe",
    wallet_id: null,
    monthly_cents: cents,
    net_cents: cents,
    status: "active",
    cancel_at_period_end: false,
    current_period_end: iso(nowMs + 18 * DAY),
    past_due_since: null,
    discount_cents: 0,
    pending_plan_key: null,
    pending_plan_at: null,
    pending_plan_from: null,
    ...over,
  };
}

function view(nowMs: number, over: Partial<PortalHomeView>): PortalHomeView {
  return {
    nowMs,
    userEmail: "member@example.test",
    member: null,
    application: null,
    freeDayClaim: null,
    interestSignupAt: null,
    subscription: null,
    askDirectory: false,
    vouchAsks: [],
    onchainWallet: null,
    onchainInvoice: null,
    idleWallet: null,
    hereNowCount: 3,
    installPromptEligible: false,
    dayCode: null,
    ...over,
    preview: true,
  };
}

const dayPlan = (key: "member_basic" | "member_2day" | "member_5day", dollars: number, passes: number): PortalFixture => ({
  key: `day-plan-${dollars}`,
  label: `$${dollars} day plan member`,
  shows: `${PLANS[key].label}: ${passes === 1 ? "a pass" : `${passes} passes`} ready, the plan card with Change plan.`,
  nav: { memberType: "day_pass", steward: false },
  view: (now) => view(now, {
    member: member(now, { name: "Riley Example", member_type: "day_pass", day_passes_balance: passes, approved: true }),
    subscription: plan(now, key),
  }),
});

export const PORTAL_FIXTURES: readonly PortalFixture[] = [
  {
    key: "day-pass",
    label: "day pass member, no plan",
    shows: "Free day booked for today, no passes yet, the next step to join.",
    nav: { memberType: "day_pass", steward: false },
    view: (now) => view(now, {
      member: member(now, { name: "Jordan Example", member_type: "day_pass", created_at: iso(now - 3 * DAY) }),
      freeDayClaim: { claimed_date: boulderDate(now), status: "reserved" },
    }),
  },
  {
    key: "day-pass-used",
    label: "day pass member who used their free day",
    shows: "No passes left, approved to join: the pick-your-plan card.",
    nav: { memberType: "day_pass", steward: false },
    view: (now) => view(now, {
      member: member(now, { name: "Casey Example", member_type: "day_pass", approved: true, created_at: iso(now - 30 * DAY) }),
    }),
  },
  dayPlan("member_basic", 30, 1),
  dayPlan("member_2day", 50, 2),
  {
    ...dayPlan("member_5day", 100, 4),
    shows: "Member + 5 days/mo with a day code live today (placeholder code).",
    view: (now) => view(now, {
      member: member(now, { name: "Riley Example", member_type: "day_pass", day_passes_balance: 4, approved: true }),
      subscription: plan(now, "member_5day"),
      dayCode: { code: PLACEHOLDER_CODE, expires_at: iso(now + 4 * 3_600_000) },
    }),
  },
  {
    key: "hot-desk",
    label: "hot desk member",
    shows: "Door code (placeholder), guest passes, the plan card.",
    nav: { memberType: "hot_desk", steward: false },
    view: (now) => view(now, {
      member: member(now, { name: "Morgan Example", member_type: "hot_desk", pin_code: PLACEHOLDER_CODE, day_passes_balance: 2 }),
      subscription: plan(now, "hot_desk"),
    }),
  },
  {
    key: "cold-desk",
    label: "cold desk member",
    shows: "Door code (placeholder), the cold desk plan.",
    nav: { memberType: "cold_desk", steward: false },
    view: (now) => view(now, {
      member: member(now, { name: "Avery Example", member_type: "cold_desk", pin_code: PLACEHOLDER_CODE }),
      subscription: plan(now, "cold_desk"),
    }),
  },
  {
    key: "past-due",
    label: "hot desk member whose payment is past due",
    shows: "The past-due banner on top, the failed-payment line on the plan.",
    nav: { memberType: "hot_desk", steward: false },
    view: (now) => view(now, {
      member: member(now, { name: "Quinn Example", member_type: "hot_desk", pin_code: PLACEHOLDER_CODE }),
      subscription: plan(now, "hot_desk", { status: "past_due", past_due_since: iso(now - 3 * DAY), current_period_end: iso(now - 3 * DAY) }),
    }),
  },
  {
    key: "set-to-end",
    label: "cold desk member whose plan is set to end",
    shows: "“Cancelling on” the period's end, no Change plan.",
    nav: { memberType: "cold_desk", steward: false },
    view: (now) => view(now, {
      member: member(now, { name: "Sky Example", member_type: "cold_desk", pin_code: PLACEHOLDER_CODE }),
      subscription: plan(now, "cold_desk", { cancel_at_period_end: true }),
    }),
  },
  {
    key: "first-week",
    label: "new hot desk member in their first week",
    shows: "No door code yet, the first-week checklist, the directory ask.",
    nav: { memberType: "hot_desk", steward: false },
    view: (now) => view(now, {
      member: member(now, {
        name: "Rowan Example", member_type: "hot_desk", created_at: iso(now - 2 * DAY),
        bio: null, telegram_username: null, show_in_directory: null,
      }),
      subscription: plan(now, "hot_desk"),
      interestSignupAt: iso(now - 45 * DAY),
      askDirectory: true,
    }),
  },
  {
    key: "applicant",
    label: "applicant not yet approved",
    shows: "No member row yet: the application under review.",
    nav: { memberType: null, steward: false },
    view: (now) => view(now, {
      application: { status: "pending", email: "applicant@example.test", known_by_member_id: 1, vouched_at: null },
    }),
  },
  {
    key: "newcomer",
    label: "signed-in newcomer, not a member",
    shows: "Apply or try a free day.",
    nav: { memberType: null, steward: false },
    view: (now) => view(now, { userEmail: "newcomer@example.test" }),
  },
  {
    key: "coop-steward",
    label: "co-op member who is a Techne steward",
    shows: "Who came in, the invite card (sample link), Events in the menu.",
    nav: { memberType: "cold_desk", steward: true },
    view: (now) => view(now, {
      member: member(now, { name: "Sage Example", member_type: "cold_desk", pin_code: PLACEHOLDER_CODE, is_coop_member: true, day_passes_balance: 5 }),
      subscription: plan(now, "cold_desk"),
    }),
  },
];

export function portalFixture(key: string): PortalFixture | null {
  return PORTAL_FIXTURES.find((f) => f.key === key) ?? null;
}
