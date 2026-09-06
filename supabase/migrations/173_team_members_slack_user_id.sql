-- 173: Slack member ID on team members.
-- Optimus (speed to lead, hand-offs) mentions people by this instead of
-- guessing from their first name. Set from the dashboard Team page.
alter table team_members add column if not exists slack_user_id text;
comment on column team_members.slack_user_id is 'Slack member ID (starts with U). Used by Optimus @mentions.';
