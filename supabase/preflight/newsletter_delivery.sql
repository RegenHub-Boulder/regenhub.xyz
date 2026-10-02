-- READ ONLY, before applying 053. Supervised operator session only.
begin read only;
select filename, applied_at from schema_migrations where filename >= '052' order by filename;
select i.status as issue_status, s.status as send_status, count(*) as recipients,
  count(*) filter (where s.attempts > 0) as previously_attempted
from newsletter_issues i left join newsletter_sends s on s.issue_id=i.id
 group by i.status, s.status order by i.status, s.status;
-- Must investigate before applying: new recipients are normalized to trim/lower.
select count(*) as issue_address_groups_with_duplicates from (
  select issue_id, lower(trim(email)) from newsletter_sends
  group by issue_id, lower(trim(email)) having count(*) > 1
) duplicates;
select count(*) as noncanonical_addresses from newsletter_sends where email <> lower(trim(email));
select grantee, table_name, privilege_type from information_schema.role_table_grants
where table_schema='public' and table_name in ('newsletter_issues','newsletter_sends')
  and privilege_type in ('INSERT','UPDATE','DELETE','TRUNCATE') order by table_name, grantee;
rollback;
