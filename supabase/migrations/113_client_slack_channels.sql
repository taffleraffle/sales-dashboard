-- Slack channel mapping per client (shared + internal per ROM team-model memory)
alter table clients add column if not exists client_slack_channel_id text;
alter table clients add column if not exists internal_slack_channel_id text;

create index if not exists idx_clients_slack_shared on clients(client_slack_channel_id) where client_slack_channel_id is not null;
create index if not exists idx_clients_slack_internal on clients(internal_slack_channel_id) where internal_slack_channel_id is not null;

-- Bulk-populate the 8 clients we have confident channel matches for
update clients set client_slack_channel_id='C0B1T2QEPS6', internal_slack_channel_id='C0B274MJ013' where slug='roofing-by-valor';
update clients set client_slack_channel_id='C0B2FREKL3B', internal_slack_channel_id='C0B1V2VEZQF' where slug='austin-area-roofers-demo';
update clients set client_slack_channel_id='C0AUWRMDCE7', internal_slack_channel_id='C09L47PL39U' where slug='medical-cosmetic-enhancements';
update clients set client_slack_channel_id='C0B0J1ALX0U', internal_slack_channel_id='C09CHQYA87J' where slug='varcoe-air-conditioning';
update clients set client_slack_channel_id='C0B1X86AZ6K', internal_slack_channel_id='C09BDQZ3HPA' where slug='organic-solutions-idaho';
update clients set client_slack_channel_id='C0B2G6SNN9E', internal_slack_channel_id='C0B20QZ7QKT' where slug='fort-knox-security';
update clients set client_slack_channel_id='C0A1FQ5Q3TR', internal_slack_channel_id='C09VAS0P4KU' where slug='smoother-movers-bc';
update clients set client_slack_channel_id='C0A05DXU3JP', internal_slack_channel_id='C09R6UH59NU' where slug='national-appliance-repairs';
-- The Property Plug has internal only (no shared client channel yet)
update clients set internal_slack_channel_id='C0AES3TK9FZ' where slug='the-property-plug';

notify pgrst, 'reload schema';
