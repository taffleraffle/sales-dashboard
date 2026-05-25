-- 023_downsell_decouple_from_contracts.sql
-- Downsell coaching sessions should not require a Contract row. A closer
-- might be saving a wobbling client who never made it to contract stage,
-- or whose contract isn't in our system. Originally the schema assumed
-- 1:1 with a contract (NOT NULL FK on contract_id); we're loosening that.
--
-- Changes:
--   1. contract_id becomes nullable (still a FK if present, for the case
--      where the session IS tied to a known contract — gives the coach
--      the fee context).
--   2. New columns client_name + client_company on the thread row, so a
--      session that ISN'T tied to a contract still tells the closer who
--      it's about. When contract_id is present, client_name can still be
--      stored on the thread (denormalised) for fast list rendering.
--   3. Drop the no-longer-used structured-offer columns the simplified
--      coach won't be writing to. Keeping the message thread + opening
--      context — that's the whole feature.

ALTER TABLE public.contract_downsell_threads
  ALTER COLUMN contract_id DROP NOT NULL;

ALTER TABLE public.contract_downsell_threads
  ADD COLUMN IF NOT EXISTS client_name text,
  ADD COLUMN IF NOT EXISTS client_company text;

-- Backfill client_name from the linked contract for existing threads so
-- the list page renders correctly during the transition.
UPDATE public.contract_downsell_threads t
SET client_name    = COALESCE(t.client_name, c.client_name),
    client_company = COALESCE(t.client_company, c.client_company)
FROM public.contracts c
WHERE t.contract_id = c.id
  AND (t.client_name IS NULL OR t.client_company IS NULL);

NOTIFY pgrst, 'reload schema';
