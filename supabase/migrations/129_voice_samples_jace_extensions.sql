-- Extends voice_samples (from migration 118) with the explicit fields the
-- Jace.ai backfill agent needs. Additive only, safe to re-run.
-- Source-of-truth spec lives in project_rom_voice_system memory.

alter table voice_samples
  add column if not exists sent_at timestamptz,
  add column if not exists thread_id text,
  add column if not exists recipient_domain text,
  add column if not exists word_count integer,
  add column if not exists has_em_dash boolean default false,
  add column if not exists has_ai_slop boolean default false;

-- Constrain context to the spec's enum without breaking the existing
-- looser values from 118 (those rows pre-date Jace ingest).
alter table voice_samples drop constraint if exists voice_samples_context_chk;
alter table voice_samples
  add constraint voice_samples_context_chk
  check (context is null or context in (
    'cold_outreach','client_comms','internal','sales','retention','other',
    -- legacy values from migration 118 kept valid:
    'client_email','slack','doc','ops'
  ));

create index if not exists voice_samples_sender_sent_idx
  on voice_samples(sender_email, sent_at desc);

create index if not exists voice_samples_thread_idx
  on voice_samples(thread_id);

-- de-dupe guard: same gmail message should never ingest twice
create unique index if not exists voice_samples_gmail_unique
  on voice_samples(source, source_ref)
  where source = 'gmail';
