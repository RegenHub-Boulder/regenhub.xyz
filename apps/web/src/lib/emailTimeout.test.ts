import { afterEach, expect, it, vi } from 'vitest';
import { sendEmailDetailed } from './email';
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
it('installed SDK passes an abort timeout to fetch without any network I/O', async () => {
  vi.stubEnv('RESEND_API_KEY', 'test-only');
  const timeout = vi.spyOn(AbortSignal, 'timeout');
  const fetch = vi.fn(async (_url: unknown, options: RequestInit) => {
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(new Headers(options.headers).get('Idempotency-Key')).toBe('newsletter:1:1');
    return new Response(JSON.stringify({ id: 'mock-message' }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetch);
  expect(await sendEmailDetailed({ to: 'test@example.com', subject: 'test', html: 'test', idempotencyKey: 'newsletter:1:1' })).toMatchObject({ ok: true });
  expect(timeout).toHaveBeenCalledWith(30_000);
  expect(fetch).toHaveBeenCalledTimes(1);
  timeout.mockRestore();
});
