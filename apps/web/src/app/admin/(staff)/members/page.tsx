import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/admin";
import { createServiceClient } from "@/lib/supabase/admin";
import { PeopleTabs } from "@/components/admin/PeopleTabs";
import { MembersList } from "@/components/admin/MembersList";
import { peoplePending } from "@/lib/peoplePending";

export const metadata = { title: "Members — Admin" };

/** People → Members. The list itself is a client component (it reads /api/admin/users and filters in place). */
export default async function MembersPage() {
  if (!await requireAdmin()) redirect("/portal");
  const pending = await peoplePending(createServiceClient());
  return (
    <div className="space-y-6">
      <PeopleTabs active="members" pending={pending} />
      <MembersList />
    </div>
  );
}
