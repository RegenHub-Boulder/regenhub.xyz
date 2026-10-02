#!/usr/bin/env bash
set -euo pipefail
# No .env loading, no inferred Supabase URL, no real provider.
if [[ "${NEWSLETTER_TEST_DATABASE_URL:-}" != 'postgres://postgres@127.0.0.1:55497/postgres' ]]; then
  echo 'Set NEWSLETTER_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55497/postgres explicitly.' >&2
  exit 2
fi
cd "$(dirname "$0")/.."
env -i PATH="$PATH" HOME="$HOME" TMPDIR="${TMPDIR:-/home/uni/.hermes/cache/scratch}" \
  NEWSLETTER_TEST_DATABASE_URL="$NEWSLETTER_TEST_DATABASE_URL" \
  NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 NEXT_PUBLIC_SUPABASE_ANON_KEY=local-test-placeholder \
  NEXT_PUBLIC_SITE_URL=http://127.0.0.1:3000 \
  pnpm --filter web exec vitest run test/newsletterDelivery.sql.test.ts
