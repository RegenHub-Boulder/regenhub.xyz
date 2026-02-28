import { createClient } from "@/lib/supabase/server";
import { notFound } from "next/navigation";
import { MemberForm } from "@/components/admin/MemberForm";

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
    </div>
  );
}
