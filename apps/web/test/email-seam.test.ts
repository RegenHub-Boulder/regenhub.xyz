/**
 * One send function (lib/email.ts deliver): every email the web app sends reaches a mail service only through the
 * provider EMAIL_PROVIDER names, so moving to Amazon SES is a setting plus one provider entry (T-497).
 */
import { afterEach, expect, it, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { deliver, emailProvider, isEmailConfigured, sendEmail, sendEmailDetailed } from "@/lib/email";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const SRC = resolve(__dirname, "../src");
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f) ? [p] : [];
  });
}

it("only lib/email.ts talks to a mail provider", () => {
  const reach = files(SRC).filter((f) => /from ["']resend["']|api\.resend\.com|\.emails\.send\(/.test(readFileSync(f, "utf8")));
  expect(reach.map((f) => relative(SRC, f))).toEqual(["lib/email.ts"]);
});

it("the provider is a setting: an unknown one sends nothing, through either send function", async () => {
  vi.stubEnv("RESEND_API_KEY", "test-only");
  vi.stubEnv("EMAIL_FROM", "RegenHub <hello@regenhub.test>");
  const net = vi.fn(async () => new Response(JSON.stringify({ id: "x" }), { status: 200, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", net);
  expect(emailProvider()?.name).toBe("resend");
  expect(isEmailConfigured()).toBe(true);

  vi.stubEnv("EMAIL_PROVIDER", "ses");
  expect(emailProvider()).toBeNull();
  expect(isEmailConfigured()).toBe(false);
  const mail = { to: "a@example.test", subject: "s", html: "<p>h</p>" };
  expect(await deliver(mail)).toMatchObject({ ok: false, error: expect.stringContaining("unknown EMAIL_PROVIDER") });
  expect(await sendEmail(mail)).toBe(false);
  expect(await sendEmailDetailed(mail)).toMatchObject({ ok: false });
  expect(net).not.toHaveBeenCalled();

  vi.stubEnv("EMAIL_PROVIDER", "resend");
  expect(await sendEmail(mail)).toBe(true);
  expect(net).toHaveBeenCalledTimes(1);
});

it("the staging outbox provider works only with the Techne stand-in on, never on regenhub.xyz", async () => {
  vi.stubEnv("EMAIL_PROVIDER", "outbox");
  vi.stubEnv("EMAIL_FROM", "RegenHub <hello@regenhub.test>");
  const mail = { to: "a@example.test", subject: "staged", html: "<p>h</p>" };
  vi.stubEnv("TECHNE_STAGING_STANDIN", "1");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://regenhub.xyz");
  expect(await deliver(mail)).toMatchObject({ ok: false, error: "email not configured" });
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "http://127.0.0.1:18700");
  expect(await deliver(mail)).toMatchObject({ ok: true });
  const { stagingOutboxMails } = await import("@/lib/staging/outbox");
  expect(stagingOutboxMails()[0]).toMatchObject({ to: "a@example.test", subject: "staged" });
});
