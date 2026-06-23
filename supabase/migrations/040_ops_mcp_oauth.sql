-- Migration 040: OAuth storage for the RegenHub Ops MCP (apps/mcp)
--
-- The ops MCP is an OAuth 2.1 Resource Server + Authorization Server (via the
-- MCP SDK's auth module). Identity = RegenHub admin (members.is_admin); tokens
-- are bound to a member. These tables persist DCR clients, short-lived auth
-- codes (PKCE), and access/refresh tokens so the server survives restarts.
--
-- Secrets are stored HASHED (sha-256). Writes go through the MCP server's
-- service-role client. RLS lets an admin read their own tokens (for a future
-- "connected apps" view); nobody else reads anything.

-- Dynamically-registered OAuth clients (RFC 7591).
create table mcp_oauth_clients (
  client_id            text primary key,
  client_secret_hash   text,                          -- null for public/PKCE clients
  redirect_uris        text[] not null,
  client_name          text,
  created_at           timestamptz not null default now()
);

-- Short-lived authorization codes (Authorization Code + PKCE).
create table mcp_oauth_codes (
  code_hash            text primary key,
  client_id            text not null references mcp_oauth_clients(client_id) on delete cascade,
  member_id            integer not null references members(id) on delete cascade,
  code_challenge       text not null,                 -- PKCE S256 challenge
  redirect_uri         text not null,
  scopes               text[] not null default '{}',
  resource             text,                          -- RFC 8707 resource indicator
  expires_at           timestamptz not null,
  created_at           timestamptz not null default now()
);
create index mcp_oauth_codes_expires_idx on mcp_oauth_codes (expires_at);

-- Access + refresh tokens (hashed at rest, bound to a member + client).
create table mcp_oauth_tokens (
  token_hash           text primary key,
  kind                 text not null check (kind in ('access', 'refresh')),
  client_id            text not null references mcp_oauth_clients(client_id) on delete cascade,
  member_id            integer not null references members(id) on delete cascade,
  scopes               text[] not null default '{}',
  resource             text,
  expires_at           timestamptz,                   -- null = no expiry (refresh tokens)
  revoked_at           timestamptz,
  created_at           timestamptz not null default now()
);
create index mcp_oauth_tokens_member_idx on mcp_oauth_tokens (member_id);
create index mcp_oauth_tokens_client_idx on mcp_oauth_tokens (client_id);

alter table mcp_oauth_clients enable row level security;
alter table mcp_oauth_codes   enable row level security;
alter table mcp_oauth_tokens  enable row level security;

create policy "admins_read_own_mcp_tokens" on mcp_oauth_tokens
  for select using (member_id in (select id from members where supabase_user_id = auth.uid()));
-- Clients/codes have no read policy (service-role only). All writes are service-role.
