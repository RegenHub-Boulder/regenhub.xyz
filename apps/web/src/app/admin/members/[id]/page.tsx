import { createClient } from "@/lib/supabase/server";
import { notFound } from "next/navigation";
import { MemberForm } from "@/components/admin/MemberForm";
import { AddPassesCard } from "@/components/admin/AddPassesCard";
import { PaymentLinkCard } from "@/components/admin/PaymentLinkCard";

export const metadata = { title: "Edit Member — Admin" };

export default async function EditMemberPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: member } = await supabase
    .from("members")
    .select("*")
    .eq("id", Number(id))
    .single();

  if (!member) notFound();

  return (
    <div className="space-y-8 max-w-2xl">
      <div>
        <h1 className="text-3xl font-bold text-forest">Edit Member</h1>
        <p className="text-muted mt-1">{member.name}</p>
      </div>
      <MemberForm member={member} />
      <AddPassesCard memberId={member.id} initialBalance={member.day_passes_balance} />
      <PaymentLinkCard
        memberName={member.name}
        daypassUrl={process.env.NEXT_PUBLIC_STRIPE_DAYPASS_LINK
          ? `${process.env.NEXT_PUBLIC_STRIPE_DAYPASS_LINK}?client_reference_id=${member.id}&prefilled_email=${encodeURIComponent(member.email ?? "")}`
          : null}
        fivepackUrl={process.env.NEXT_PUBLIC_STRIPE_FIVEPACK_LINK
          ? `${process.env.NEXT_PUBLIC_STRIPE_FIVEPACK_LINK}?client_reference_id=${member.id}&prefilled_email=${encodeURIComponent(member.email ?? "")}`
          : null}
      />
    </div>
  );
}
