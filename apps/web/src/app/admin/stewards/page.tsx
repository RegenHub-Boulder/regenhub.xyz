import { notFound } from "next/navigation";
import { ShieldCheck } from "lucide-react";
import { techneConfig } from "@/lib/techne/config";
import { regenosCollectiveDid } from "@/lib/regenos/config";
import { currentTechne } from "@/lib/techne/webSession";
import { stewardCheck } from "@/lib/techne/roster";
import { MANAGE_ROLE, roleName } from "@/lib/techne/roles";
import { handleFor, shortDid } from "@/lib/techne/did";
import { SignInWithTechne, SignOutOfTechne } from "@/components/techne/SignInWithTechne";
import { StewardRoster, type RosterRow } from "@/components/admin/StewardRoster";

export const metadata = { title: "RegenHub stewards — Admin" };

/** Read fresh on every visit: a change has to show at once. */
export const dynamic = "force-dynamic";

const PATH = "/admin/stewards";

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="glass-panel p-6 md:p-8 max-w-lg space-y-3" data-testid="stewards-panel">
      <h2 className="text-xl font-semibold">{title}</h2>
      <div className="text-muted text-sm space-y-3 leading-relaxed">{children}</div>
    </div>
  );
}

/**
 * RegenHub stewards: who holds a role in RegenHub on Techne, and (for its facilitators and managers) adding,
 * changing and ending roles. It sits with the admin pages but answers to the Techne role, not the portal: a
 * Techne sign-in at facilitator or above in RegenHub's public membership claims is what lets someone use it, and
 * the Supabase admin flag neither grants that nor is needed. Writes go through POST /api/techne/stewards.
 */
export default async function StewardsPage() {
  const collective = regenosCollectiveDid();
  if (!techneConfig() || !collective) notFound();

  const header = (
    <div>
      <h1 className="text-3xl font-bold text-forest flex items-center gap-3">
        <ShieldCheck className="w-7 h-7 text-sage" />
        RegenHub stewards
      </h1>
      <p className="text-muted mt-1">Who holds a role in RegenHub on Techne.</p>
    </div>
  );

  const techne = await currentTechne();
  if (!techne) {
    return (
      <div className="space-y-8">
        {header}
        <Panel title="Sign in with Techne">
          <p>RegenHub&apos;s roles live on Techne. Its facilitators and managers sign in with Techne here to add people and change roles.</p>
          <div className="pt-1 text-center">
            <SignInWithTechne next={PATH} />
          </div>
        </Panel>
      </div>
    );
  }

  const check = await stewardCheck(collective, techne.did);
  const who = (
    <div className="text-xs text-muted flex flex-wrap items-center gap-x-3 gap-y-1" data-testid="stewards-who">
      <span>
        Signed in with Techne as <code className="text-foreground">{techne.handle ? `@${techne.handle}` : techne.did}</code>
      </span>
      <SignOutOfTechne next={PATH} />
    </div>
  );
  if (!check) {
    return (
      <div className="space-y-8">
        {header}
        {who}
        <p className="text-sm text-red-300" role="alert">
          Couldn&apos;t read RegenHub&apos;s roles from Techne just now. Reload to try again.
        </p>
      </div>
    );
  }

  const { holders, me } = check;
  const rows: RosterRow[] = await Promise.all(
    holders.map(async (h) => {
      const handle = await handleFor(h.did);
      return { did: h.did, role: h.role, since: h.since, label: handle ? `@${handle}` : shortDid(h.did) };
    }),
  );

  if (!check.steward) {
    const managers = rows.filter((r) => r.role >= MANAGE_ROLE);
    return (
      <div className="space-y-8">
        {header}
        {who}
        <Panel title="This page is for RegenHub's facilitators and managers">
          <p data-testid="stewards-explainer">
            {me
              ? `On Techne you're a ${roleName(me.role)} of RegenHub. Adding people and changing roles takes facilitator or manager there.`
              : "On Techne you don't hold a role in RegenHub. Adding people and changing roles takes facilitator or manager there."}{" "}
            Being an admin of this site doesn&apos;t change that: the role on Techne is what counts.
          </p>
          {managers.length > 0 && (
            <p>
              Ask {managers.map((m, i) => (
                <span key={m.did}>
                  {i > 0 ? (i === managers.length - 1 ? " or " : ", ") : ""}
                  <code className="text-foreground" title={m.did}>{m.label}</code>
                </span>
              ))}
              .
            </p>
          )}
        </Panel>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {header}
      {who}
      <StewardRoster rows={rows} me={techne.did} />
    </div>
  );
}
