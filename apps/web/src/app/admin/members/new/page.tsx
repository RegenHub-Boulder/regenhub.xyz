import { MemberForm } from "@/components/admin/MemberForm";

export const metadata = { title: "Add Member — Admin" };

interface Props {
  searchParams: Promise<{ email?: string; user_id?: string }>;
}

export default async function NewMemberPage({ searchParams }: Props) {
  const { email, user_id } = await searchParams;

  return (
    <div className="space-y-8 max-w-2xl">
      <div>
        <h1 className="text-3xl font-bold text-forest">Add Member</h1>
        <p className="text-muted mt-1">
          {email
            ? `Creating profile for ${email}`
            : "Create a new member account and assign a door slot"}
        </p>
      </div>
      <MemberForm initialEmail={email} initialUserId={user_id} />
    </div>
  );
}
