-- Migration 038: Route door-hold notifications back to the originating chat
--
-- Bug: the 10-minute warning + relock notifications were sent to
-- TELEGRAM_GROUP_CHAT_ID, which (a) wasn't even set on the bot container, so
-- they went nowhere, and (b) is the wrong target anyway — the /holdopen
-- confirmation says "I'll warn HERE", meaning the chat where the command was
-- run. A hold started in a DM should warn in that DM; one started in the
-- group should warn the group.
--
-- We capture the originating Telegram chat id per hold and send notifications
-- there, falling back to the group chat for the idle-reconcile path (which
-- has no hold to derive a chat from).

alter table door_holds add column notify_chat_id bigint;
