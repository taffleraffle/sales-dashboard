-- 050_sync_ghl_closes_to_closer_calls.sql
-- Bridges the GHL "Closed" + "Ascended Trials" pipeline stages to
-- closer_calls so dashboard close counts match GHL pipeline status.
--
-- Why: closers don't always log every close in EOD reports. GHL pipeline
-- is the source of truth for deal status. This sync ensures every GHL
-- closed/ascended opportunity becomes a closer_calls row, so the
-- dashboard's close count matches reality (49 in GHL pipeline vs 12 in
-- old EOD-only closer_calls).
--
-- Dedupe is by normalized (first_name, last_name) match against existing
-- closer_calls.prospect_name. Revenue is NULL on auto-imported rows --
-- closer fills it in manually via EOD when they confirm the deal.
--
-- Idempotent. Apply via supabase db push. Run via:
--   SELECT public.sync_ghl_closes_to_closer_calls();

BEGIN;

-- Constants for the two close stages in GHL
-- (Looked up empirically 2026-05-12 from raw_payload.opportunities)
--   b7dc415a-... = "Closed" (27 deals)
--   0f9d5445-... = "Ascended Trials" (22 deals)

CREATE OR REPLACE FUNCTION public.sync_ghl_closes_to_closer_calls()
RETURNS TABLE (inserted_count INTEGER, total_in_pipeline INTEGER)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_report_id   UUID;
  v_inserted    INTEGER := 0;
  v_total       INTEGER := 0;
  v_closer_id   UUID := '76f61d92-83d8-45ec-87a7-82b0dc6d607e';
BEGIN
  -- 1. Get-or-create the import eod_report
  SELECT id INTO v_report_id
  FROM closer_eod_reports
  WHERE notes = 'GHL pipeline auto-import'
  LIMIT 1;

  IF v_report_id IS NULL THEN
    INSERT INTO closer_eod_reports (
      closer_id, report_date,
      nc_booked, fu_booked, nc_no_shows, fu_no_shows,
      live_nc_calls, live_fu_calls, reschedules, offers, closes, deposits,
      offer1_collected, offer1_revenue, offer2_collected, offer2_revenue,
      total_revenue, total_cash_collected,
      notes, is_confirmed
    ) VALUES (
      v_closer_id, CURRENT_DATE,
      0,0,0,0,0,0,0,0,0,0,
      0,0,0,0,0,0,
      'GHL pipeline auto-import', FALSE
    ) RETURNING id INTO v_report_id;
  END IF;

  -- 2. Identify GHL contacts in Closed / Ascended Trials pipeline stages
  --    whose name isn't already in closer_calls.outcome='closed'
  WITH ghl_closed AS (
    SELECT
      c.ghl_contact_id,
      COALESCE(NULLIF(trim(c.full_name),''),
               NULLIF(trim(concat_ws(' ', c.first_name, c.last_name)),''),
               c.email, c.ghl_contact_id) AS prospect_name,
      lower(trim(coalesce(c.first_name,
                          split_part(c.full_name, ' ', 1)))) AS first_tok,
      lower(trim(coalesce(c.last_name,
                          NULLIF(split_part(c.full_name, ' ', 2), '')))) AS last_tok
    FROM ghl_contacts c
    WHERE EXISTS (
      SELECT 1
      FROM jsonb_array_elements(coalesce(c.raw_payload->'opportunities','[]'::jsonb)) AS o
      WHERE o->>'pipelineStageId' IN (
        'b7dc415a-f0a4-41dd-b113-741929eb517b',  -- Closed
        '0f9d5445-37da-487b-8925-6e0d7d35386b'   -- Ascended Trials
      )
    )
  ),
  existing AS (
    SELECT
      lower(split_part(split_part(prospect_name, ' - ', 1), ' ', 1)) AS first_tok,
      lower(coalesce(NULLIF(split_part(split_part(prospect_name, ' - ', 1), ' ', 2), ''), '')) AS last_tok
    FROM closer_calls
    WHERE outcome = 'closed' AND prospect_name IS NOT NULL
  )
  INSERT INTO closer_calls (
    eod_report_id, call_type, prospect_name, showed, outcome,
    revenue, cash_collected, notes
  )
  SELECT
    v_report_id,
    'new_call',
    g.prospect_name,
    TRUE,
    'closed',
    0,
    0,
    'Auto-imported from GHL pipeline (contact=' || g.ghl_contact_id || ')'
  FROM ghl_closed g
  WHERE NOT EXISTS (
    SELECT 1 FROM existing e
    WHERE e.first_tok = g.first_tok
      AND (
        e.last_tok = g.last_tok
        OR (e.last_tok = '' AND g.last_tok IS NULL)
        OR (g.last_tok = '' AND e.last_tok IS NULL)
      )
  );

  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  SELECT count(*) INTO v_total
  FROM ghl_contacts c
  WHERE EXISTS (
    SELECT 1
    FROM jsonb_array_elements(coalesce(c.raw_payload->'opportunities','[]'::jsonb)) AS o
    WHERE o->>'pipelineStageId' IN (
      'b7dc415a-f0a4-41dd-b113-741929eb517b',
      '0f9d5445-37da-487b-8925-6e0d7d35386b'
    )
  );

  RETURN QUERY SELECT v_inserted, v_total;
END;
$$;

GRANT EXECUTE ON FUNCTION public.sync_ghl_closes_to_closer_calls() TO anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
