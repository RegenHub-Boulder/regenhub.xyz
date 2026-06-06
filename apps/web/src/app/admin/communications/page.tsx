import type { Metadata } from "next";
import { CommunicationsComposer } from "@/components/admin/CommunicationsComposer";

export const metadata: Metadata = { title: "Communications — Admin" };

export default function CommunicationsPage() {
  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-2xl font-bold text-forest">Communications</h1>
        <p className="text-muted text-sm mt-1">
          Send a personalized email to a filtered subset of members. Idempotent
          per <code className="text-foreground">batch_id</code> — re-running with the same id
          only targets members who haven&apos;t already received this batch.
        </p>
      </div>
      <CommunicationsComposer />
    </div>
  );
}
