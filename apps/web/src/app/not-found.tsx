import { PublicShell } from "@/components/layout/PublicShell";

/** The site's one 404, on the book's paper (the same words as Next's default). */
export default function NotFound() {
  return (
    <PublicShell>
      <div className="px-6 py-20 text-center">
        <p className="text-[3rem] leading-none text-muted lining-nums">404</p>
        <hr className="mx-auto my-6 w-12 border-ink/40" />
        <h1 className="text-[1.6rem] italic">This page could not be found.</h1>
      </div>
    </PublicShell>
  );
}
