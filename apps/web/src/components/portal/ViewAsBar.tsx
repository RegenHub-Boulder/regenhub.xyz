import Link from "next/link";
import { VIEW_AS_EXIT } from "@/lib/viewAs";

/**
 * The line across the top of every page while an admin views the portal as someone else (lib/viewAs.ts): who, that
 * nothing can be changed, another view, Exit. Exit is a plain form post (no script needed).
 */
export function ViewAsBar({ label }: { label: string | null }) {
  return (
    <div className="bg-tint border-b border-rule px-6 py-2 text-sm" role="status" data-testid="view-as-bar">
      <div className="max-w-7xl mx-auto flex flex-wrap items-center gap-x-3 gap-y-1">
        {label ? (
          <>
            <span>
              Viewing as: <strong className="font-semibold">{label}</strong>
            </span>
            <span className="text-muted">· read-only, nothing here can be changed</span>
          </>
        ) : (
          // A preview cookie left from an admin's session that ended (lib/viewAs.ts): it shows nothing, but it pauses
          // changes on this browser until it is cleared.
          <span>An admin&apos;s read-only preview is still on in this browser, so nothing can be changed.</span>
        )}
        <span className="ml-auto flex items-center gap-4">
          {label && <Link href="/admin/view-as" className="text-muted hover:text-foreground">Another view</Link>}
          <form action={VIEW_AS_EXIT} method="post">
            <button type="submit" className="font-medium text-forest hover:underline">Exit</button>
          </form>
        </span>
      </div>
    </div>
  );
}

/** In place of a portal page the preview doesn't show yet: say so, rather than show the admin's own page. */
export function NotInPreview() {
  return (
    <div className="max-w-md space-y-3" data-testid="not-in-preview">
      <h1 className="text-2xl font-semibold">Not in the preview yet</h1>
      <p className="text-muted text-sm">
        The preview shows the member home. This page would show your own account, so it stays hidden while you view
        the portal as someone else.
      </p>
      <Link href="/portal" className="text-sage hover:underline text-sm">Back to their home →</Link>
    </div>
  );
}
