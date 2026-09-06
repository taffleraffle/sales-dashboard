-- 177: a new closer or setter wires themselves up (Ben, 6 Sep 2026)
--
-- "Save this all so when we onboard new closers or setters this function will
--  forever work and we don't have this manual coding thing to do."
--
-- The dialer is embedded in GoHighLevel and stamps the GHL user id on every
-- call, so a person's dialler id and their GHL user id are the same value
-- (verified for Josh, Leandre and Daniel). Nine different places in the
-- dashboard read team_members.wavv_user_id, so rather than teach each one the
-- fallback, fill the column itself the moment a GoHighLevel user is linked.
--
-- Never overwrites a value someone typed in: it only fills a NULL. If a person
-- genuinely has a different dialler seat, set it on their Team page and this
-- leaves it alone for good.

CREATE OR REPLACE FUNCTION public.team_member_autowire()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Dialler id defaults to the GoHighLevel user id
  IF NEW.wavv_user_id IS NULL AND NEW.ghl_user_id IS NOT NULL THEN
    NEW.wavv_user_id := NEW.ghl_user_id;
  END IF;

  -- Setters get the standard dial window unless someone sets their own.
  -- 9am to 7pm Eastern, the window Josh already runs.
  IF NEW.role = 'setter' THEN
    IF NEW.stl_start_hour IS NULL THEN NEW.stl_start_hour := 9; END IF;
    IF NEW.stl_end_hour   IS NULL THEN NEW.stl_end_hour   := 19; END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS team_member_autowire_trg ON public.team_members;
CREATE TRIGGER team_member_autowire_trg
  BEFORE INSERT OR UPDATE ON public.team_members
  FOR EACH ROW EXECUTE FUNCTION public.team_member_autowire();

-- Backfill anyone already on the roster
UPDATE public.team_members
   SET wavv_user_id = ghl_user_id
 WHERE wavv_user_id IS NULL AND ghl_user_id IS NOT NULL;

UPDATE public.team_members
   SET stl_start_hour = COALESCE(stl_start_hour, 9),
       stl_end_hour   = COALESCE(stl_end_hour, 19)
 WHERE role = 'setter';

COMMENT ON FUNCTION public.team_member_autowire() IS
  'Fills a new team member''s dialler id from their GoHighLevel user and gives setters the default 9-19 ET dial window. Only ever fills NULLs.';
