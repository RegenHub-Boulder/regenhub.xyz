/**
 * The "Sign in with Techne" button and its "Make one" link: the site's one sign-in button (/auth/login, /apply,
 * RSVP, the link page, the stewards' page). A plain form posting to /techne/signin: the server is the OAuth client
 * and sends the browser to the PDS. `next` is where the sign-in comes back to. Works without JavaScript.
 */

import { LogOut, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";

export function SignInWithTechne({ next, label = "Sign in with Techne" }: { next: string; label?: string }) {
  return (
    <form action="/techne/signin" method="post" className="space-y-3 max-w-sm mx-auto">
      <input type="hidden" name="next" value={next} />
      <Button type="submit" className="btn-primary-glass px-6">
        {label}
      </Button>
      <p className="text-xs text-muted leading-relaxed">
        One Techne account works on every Techne app.{" "}
        <button type="submit" name="signup" value="1" className="text-sage hover:underline inline-flex items-center gap-1">
          <UserPlus className="w-3 h-3" /> Make one
        </button>
      </p>
    </form>
  );
}

/** Ends both sessions (Techne and the portal): a plain form posting to /auth/signout, back to `next`. */
export function SignOutOfTechne({ next }: { next?: string }) {
  return (
    <form action="/auth/signout" method="post" className="inline">
      {next && <input type="hidden" name="next" value={next} />}
      <button type="submit" className="text-xs text-muted hover:text-foreground inline-flex items-center gap-1">
        <LogOut className="w-3 h-3" /> Sign out
      </button>
    </form>
  );
}
