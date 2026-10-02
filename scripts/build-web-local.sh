#!/usr/bin/env bash
set -euo pipefail
# Offline/local build: no .env secrets inherited; committed public origins are
# overridden. Never run dev/start or bot entrypoints from this script.
repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
build_support="$(mktemp -d "${TMPDIR:-/home/uni/.hermes/cache/scratch}/rh97-build.XXXXXX")"
trap 'rm -rf "$build_support"' EXIT
cat > "$build_support/block-network.cjs" <<'JS'
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const raw = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
  const url = new URL(raw);
  if (!['localhost','127.0.0.1','::1','[::1]'].includes(url.hostname)) {
    throw new Error(`Offline build blocked external host: ${url.hostname}`);
  }
  return originalFetch(input, init);
};
JS
cat > "$build_support/font-mock.cjs" <<'JS'
// Next's supported build-test response hook: no Google/font downloads.
module.exports = new Proxy({}, {get: () => "@font-face { font-family: 'Inter'; font-style: normal; font-weight: 100 900; src: local('Arial'); }"});
JS
cd "$repo_dir"
env -i PATH="$PATH" HOME="$HOME" \
  NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 NEXT_PUBLIC_SUPABASE_ANON_KEY=local-placeholder \
  NEXT_PUBLIC_SITE_URL=http://127.0.0.1:3000 SITE_URL=http://127.0.0.1:3000 \
  SUPABASE_URL=http://127.0.0.1:54321 SUPABASE_INTERNAL_URL=http://127.0.0.1:54321 \
  SUPABASE_SERVICE_ROLE_KEY=local-placeholder REGENOS_BASE_URL=http://127.0.0.1:9 \
  REGENOS_WEB_URL=http://127.0.0.1:9 REGENOS_LOGIN_ENABLED=false \
  REGENOS_OAUTH_JWKS_URI=http://127.0.0.1:9 OP_RPC_URL=http://127.0.0.1:9 HA_URL=http://127.0.0.1:9 \
  NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=local-placeholder STRIPE_SECRET_KEY=sk_test_local_placeholder \
  NODE_OPTIONS="--require=$build_support/block-network.cjs" NEXT_TELEMETRY_DISABLED=1 \
  NEXT_FONT_GOOGLE_MOCKED_RESPONSES="$build_support/font-mock.cjs" \
  pnpm --filter web build "$@"
