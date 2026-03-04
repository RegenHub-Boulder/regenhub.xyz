-- Rename member_type enum values to match coworking tiers
alter type member_type rename value 'full' to 'cold_desk';
alter type member_type add value 'hot_desk';
alter type member_type rename value 'daypass' to 'day_pass';

-- Add co-op member flag (separate from coworking membership)
alter table members add column is_coop_member boolean not null default false;

-- Migrate: anyone with membership_tier = 'cooperative' becomes a co-op member
update members set is_coop_member = true where membership_tier = 'cooperative';

-- Drop the old membership_tier column and enum
alter table members drop column membership_tier;
drop type membership_tier;
