import { afterEach, expect, it, vi } from "vitest";
const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("resend", () => ({ Resend: class { fetchRequest = vi.fn(); emails = { send }; } }));
import { sendEmailDetailed } from "./email";
afterEach(() => { vi.unstubAllEnvs(); send.mockReset(); });
const input = { to: "test@example.com", subject: "test", html: "hello", idempotencyKey: "newsletter:1:1" };
it("passes stable key through installed Resend SDK options and returns message id", async () => {
  vi.stubEnv("RESEND_API_KEY", "test-only"); send.mockResolvedValue({ data: { id: "msg" }, error: null });
  expect(await sendEmailDetailed(input)).toMatchObject({ ok: true, id: "msg" });
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ to: input.to }), { idempotencyKey: input.idempotencyKey });
});
it.each(["application_error", "internal_server_error", "concurrent_idempotent_requests", "invalid_idempotent_request"])("treats %s as unknown acceptance", async (name) => {
  vi.stubEnv("RESEND_API_KEY", "test-only"); send.mockResolvedValue({ data: null, error: { name, message: "unknown" } });
  expect(await sendEmailDetailed(input)).toMatchObject({ ok: false, ambiguous: true });
});
it("transport exceptions are ambiguous", async () => {
  vi.stubEnv("RESEND_API_KEY", "test-only"); send.mockRejectedValue(new Error("connection lost"));
  expect(await sendEmailDetailed(input)).toMatchObject({ ok: false, ambiguous: true });
});
it("known validation rejection is terminal", async () => {
  vi.stubEnv("RESEND_API_KEY", "test-only"); send.mockResolvedValue({ data: null, error: { name: "validation_error", message: "bad address" } });
  expect(await sendEmailDetailed(input)).toMatchObject({ ok: false, ambiguous: false });
});
