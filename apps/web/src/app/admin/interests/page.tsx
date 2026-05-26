import { redirect } from "next/navigation";

export default async function InterestsRedirect({
  searchParams,
}: {
  searchParams: Promise<{ linked?: string }>;
}) {
  const params = await searchParams;
  const q = new URLSearchParams();
  q.set("tab", "interests");
  if (params.linked) q.set("linked", params.linked);
  redirect(`/admin/pipeline?${q.toString()}`);
}
