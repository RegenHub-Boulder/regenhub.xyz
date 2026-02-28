import { MemberForm } from "@/components/admin/MemberForm";

export const metadata = { title: "Add Member — Admin" };

export default function NewMemberPage() {
  return (
    <div className="space-y-8 max-w-2xl">
      <div>
        <h1 className="text-3xl font-bold text-forest">Add Member</h1>
        <p className="text-muted mt-1">Create a new member account and assign a door slot</p>
      </div>
      <MemberForm />
    </div>
  );
}
