import { readFileSync, existsSync } from 'node:fs';
import { expect, it } from 'vitest';
import { migrationNumber } from './migrations';

const path = new URL('../../../../supabase/migrations/055_newsletter_claims.sql', import.meta.url);
const sql = readFileSync(path, 'utf8');
it('ships newsletter claims as 054, leaving 053 for the lock-slot migration', () => {
  expect(migrationNumber('055_newsletter_claims.sql')).toBe(54);
  expect(existsSync(new URL('../../../../supabase/migrations/053_newsletter_claims.sql', import.meta.url))).toBe(false);
});
it('dispatch authorization fences both leases and retains original dispatch provenance', () => {
  const dispatch = sql.split('create or replace function public.newsletter_dispatch_recipient')[1].split('end $$;')[0];
  expect(dispatch).toContain('run_token = p_token');
  expect(dispatch).toContain("run_claimed_at > clock_timestamp() - interval '15 minutes'");
  expect(dispatch).toContain('claim_token = p_token');
  expect(dispatch).toContain("claimed_at > clock_timestamp() - interval '15 minutes'");
  expect(dispatch).toContain('dispatched_at = clock_timestamp()');
  expect(dispatch).toContain('first_attempt_at = coalesce(first_attempt_at, clock_timestamp())');
  expect(dispatch).toContain("first_attempt_at > clock_timestamp() - interval '23 hours'");
  expect(dispatch).toContain("status = 'needs_review'");
  expect(sql).toContain('new.first_attempt_at is distinct from old.first_attempt_at');
  expect(sql).toContain('new.payload is distinct from old.payload');
  expect(sql.match(/public.newsletter_dispatch_recipient\(integer,bigint,uuid\)/g)).toHaveLength(2);
});
it('claim and dispatch consult current opt-outs; prepare cancels only unattempted pending rows', () => {
  const claim = sql.split('create or replace function public.newsletter_claim_recipient')[1].split('end $$;')[0];
  expect(claim).toContain('not exists (select 1 from email_unsubscribes');
  const dispatch = sql.split('create or replace function public.newsletter_dispatch_recipient')[1].split('end $$;')[0];
  expect(dispatch).toContain('not exists (select 1 from email_unsubscribes');
  const prepare = sql.split('create or replace function public.newsletter_prepare')[1].split('end $$;')[0];
  expect(prepare).toContain("status = 'pending' and first_attempt_at is null");
  expect(prepare).toContain('not exists (select 1 from jsonb_to_recordset(p_rows)');
});
