import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { Button } from "@/components/ui/button";
import { CalendarDays, KeyRound, ShieldQuestion } from "lucide-react";
import { isRegenosEventsConfigured, isRegenosLoginEnabled, regenosCollectiveDid } from "@/lib/regenos/config";
import { fetchRegenosIdentity, fetchRegenosSceneStanding } from "@/lib/regenos/auth";
import { fetchCollectiveEventsForManagement } from "@/lib/regenos/events";
import { ManageEvents, type ManageableEvent } from "@/components/portal/ManageEvents";

export const metadata = { title: "Manage Events — RegenHub" };

/** Every read here is per-caller and per-cookie; nothing about this page is cacheable. */
export const dynamic = "force-dynamic";

function Explainer({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="glass-panel p-8 max-w-lg">
      <h2 className="text-xl font-semibold mb-3">{title}</h2>
      <div className="text-muted text-sm space-y-3 leading-relaxed">{children}</div>
    </div>
  );
}

export default async function ManageEventsPage() {
  // The whole lane rides the login flag: no regenOS session, no way to authenticate a write.
  if (!isRegenosLoginEnabled()) notFound();

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const header = (
    <div>
      <h1 className="text-3xl font-bold text-forest flex items-center gap-3">
        <CalendarDays className="w-7 h-7 text-sage" />
        Manage Events
      </h1>
      <p className="text-muted mt-1">RegenHub&apos;s calendar on the commons, edited here.</p>
    </div>
  );

  const collectiveDid = regenosCollectiveDid();
  if (!isRegenosEventsConfigured() || !collectiveDid) {
    return (
      <div className="space-y-8">
        {header}
        <Explainer title="Events aren't wired up yet">
          <p>
            The collective&apos;s calendar lives in regenOS, and this deployment doesn&apos;t have a
            collective configured yet. An admin needs to set <code>REGENOS_COLLECTIVE_DID</code>.
          </p>
        </Explainer>
      </div>
    );
  }

  // The regenOS session cookie was set on THIS origin by the /xrpc proxy, so we
  // can replay the caller's own cookies to the AppView and ask who they are.
  const cookieHeader = (await cookies()).toString();
  const identity = await fetchRegenosIdentity(cookieHeader);

  if (!identity) {
    return (
      <div className="space-y-8">
        {header}
        <Explainer title="Sign in with regenOS to manage events">
          <p>
            You&apos;re signed in to RegenHub, but events live on the commons and need your regenOS
            identity — that&apos;s what proves to the calendar that you&apos;re a steward here.
          </p>
          <p>Sign in through the regenOS lane and come back.</p>
          <Link href="/auth/login" className="inline-block pt-1">
            <Button className="btn-primary-glass gap-2 px-6">
              <KeyRound className="w-4 h-4" />
              Sign in with regenOS
            </Button>
          </Link>
        </Explainer>
      </div>
    );
  }

  const standing = await fetchRegenosSceneStanding(cookieHeader, collectiveDid, identity.did);

  if (!standing.canManageEvents) {
    return (
      <div className="space-y-8">
        {header}
        <Explainer title="Only stewards edit the calendar">
          <p>
            You&apos;re signed in as{" "}
            <strong className="text-foreground">{identity.handle ?? identity.did}</strong>, but the
            collective lists you as{" "}
            <strong className="text-foreground">{standing.role ?? "not a member"}</strong>. Creating
            and editing RegenHub events needs Builder or higher.
          </p>
          <p className="flex items-start gap-2">
            <ShieldQuestion className="w-4 h-4 mt-0.5 shrink-0 text-sage" />
            <span>
              If that&apos;s wrong, ask a steward to update your role in the collective — the calendar
              reads it live, so it takes effect as soon as they do.
            </span>
          </p>
        </Explainer>
      </div>
    );
  }

  const events = await fetchCollectiveEventsForManagement(cookieHeader);
  const manageable: ManageableEvent[] = events.map((e) => ({
    uri: e.uri,
    rkey: e.rkey,
    name: e.name,
    startAt: e.startAt,
    visibility: e.visibility,
    value: e.value,
    url: e.url,
  }));

  return (
    <div className="space-y-8">
      {header}
      <ManageEvents authority={collectiveDid} events={manageable} />
    </div>
  );
}
