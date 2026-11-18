"use client";

import { useRef } from "react";
import type { TechneConfig } from "@/lib/techne/config";
import { signOutOfTechne } from "@/lib/techne/signOut";

/**
 * "Sign out" for the portal: ends the Techne session in this browser first (when the door is on), then posts
 * the form that ends the portal session (/auth/signout). Without JavaScript the form still posts, and
 * /auth/login?signed_out=1 ends the Techne session there.
 */
export function SignOutButton({ config, className }: { config: TechneConfig | null; className?: string }) {
  const form = useRef<HTMLFormElement>(null);
  const done = useRef(false);
  return (
    <form
      ref={form}
      action="/auth/signout"
      method="post"
      className={className}
      onSubmit={(e) => {
        if (done.current || !config) return;
        e.preventDefault();
        void signOutOfTechne(config).finally(() => {
          done.current = true;
          form.current?.submit();
        });
      }}
    >
      <button className="text-sm text-muted hover:text-foreground transition-colors">Sign out</button>
    </form>
  );
}
