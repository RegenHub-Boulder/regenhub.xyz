import { redirect } from "next/navigation";

/** Pipeline became People (T-482); its tabs keep their names. */
export default async function PipelineRedirect({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(await searchParams)) if (typeof v === "string") q.set(k, v);
  const s = q.toString();
  redirect(`/admin/people${s ? `?${s}` : ""}`);
}
