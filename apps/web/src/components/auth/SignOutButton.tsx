/**
 * "Sign out" for the portal: a plain form posting to /auth/signout, which ends the portal session and this
 * browser's Techne sign-in on the server (no script, nothing left in the browser to sign back in).
 */
export function SignOutButton({ className }: { className?: string }) {
  return (
    <form action="/auth/signout" method="post" className={className}>
      <button className="text-sm text-muted hover:text-foreground transition-colors">Sign out</button>
    </form>
  );
}
