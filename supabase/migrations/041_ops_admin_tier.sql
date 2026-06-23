-- Migration 041: ops-admin tier — a privilege level above the day-to-day admins.
--
-- members.is_admin stays the "management" tier (mint passes, update accounts, the
-- /admin panel — several people). is_ops_admin is the higher "ops" tier that gates
-- the RegenHub MCP's dangerous capabilities (deploys, migrations, lock debugging)
-- — only a couple of people.
--
-- Forward-looking: the MCP is meant to become one surface for many tiers (members
-- get day codes, admins manage events/members, ops get the dangerous tools). For
-- v1 the whole MCP is gated at is_ops_admin; later the entry gate relaxes to "any
-- member" and tools gate per-tier. Tokens already carry the member, so each tool
-- can check the right flag.

alter table members add column is_ops_admin boolean not null default false;

-- (Bootstrap of the first ops-admin is done out-of-band after this migration.)
