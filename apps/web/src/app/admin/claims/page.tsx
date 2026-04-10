import { createServiceClient } from "@/lib/supabase/admin";
import { ClaimsFilter } from "@/components/admin/ClaimsFilter";

export const metadata = { title: "Free Day Claims — Admin" };

export default async function ClaimsPage() {
  // Service client needed because free_day_claims isn't in the typed schema.
  // Auth is enforced by the admin layout (session + is_admin check).
  const admin = createServiceClient();

  const { data: claims } = await admin
    .from("free_day_claims")
    .select("*")
    .order("created_at", { ascending: false });

  const allClaims = (claims ?? []) as Array<{
    id: number;
    email: string;
    name: string;
    claimed_date: string;
    status: string;
    created_at: string;
    about?: string | null;
    why_join?: string | null;
    invite_code?: string | null;
  }>;

  const pendingCount = allClaims.filter((c) => c.status === "pending").length;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-forest">Free Day Claims</h1>
        <p className="text-muted text-sm mt-1">
          {allClaims.length} total · {pendingCount} pending review
        </p>
      </div>
      <ClaimsFilter claims={allClaims} />
    </div>
  );
}
