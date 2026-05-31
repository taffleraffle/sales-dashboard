-- script_mechanisms — the WHAT OPT DELIVERS layer, sitting between
-- angles (the prospect's door) and offers (the package). Ben 2026-05-31:
-- "wire up the new offer and mechanism maker."
--
-- Why this needs its own table:
--   The current script_angles row conflates the door (problem/desire)
--   with the mechanism (what OPT does to solve it). E.g. rank-1-in-ai
--   currently carries BOTH the "phone hasn't rung from organic" pain
--   AND the "we rank you in AI search" mechanism. Per Ben's 2026-05-31
--   memory feedback (feedback_messaging_problems_desires), an angle is
--   the emotional door — the same mechanism can sell into multiple
--   doors, and the same door can be paired with different mechanisms.
--
-- Schema split (non-breaking):
--   - script_angles keeps its existing mechanism_short / mechanism_long
--     columns as fallbacks (so existing rows like rank-1-in-ai keep
--     working).
--   - script_mechanisms is the new richer source. When a generation
--     call passes mechanism_slug, the Edge Function loads from here
--     and uses these values instead of the angle's mechanism fields.
--   - offer_slugs[] tags which offers a mechanism applies to.
--   - angle_slugs[] tags which angles this mechanism pairs well with
--     (empty array = available for any angle).
--
-- Generation flow after this lands:
--   1. Operator picks angle (problem/desire door)
--   2. Operator picks mechanism (what OPT does)  ← new step
--   3. Operator picks offer (audience qualifier + guarantee)
--   4. Optional: pick proof characters, hook shapes, length
--   5. Generate

BEGIN;

CREATE TABLE IF NOT EXISTS public.script_mechanisms (
  slug              TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  summary           TEXT,
  -- HOOK use: the short form that fills the "We'll {mechanism_short}" slot
  mechanism_short   TEXT NOT NULL,
  -- BODY use: expanded form for Beat 4 (mechanism reveal)
  mechanism_long    TEXT NOT NULL,
  -- BODY Beat 5 — the 3-part HOW. Each becomes one sentence in the body.
  -- Convention from the body skeleton: 5a = foundation, 5b = surface,
  -- 5c = authority/differentiator.
  beat_5a           TEXT,
  beat_5b           TEXT,
  beat_5c           TEXT,
  -- Compatibility tags so the UI can filter mechanisms when the user
  -- picks an offer or angle. Empty = available everywhere.
  offer_slugs       TEXT[] DEFAULT '{}',
  angle_slugs       TEXT[] DEFAULT '{}',
  active            BOOLEAN NOT NULL DEFAULT TRUE,
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Lookup by offer / angle for the UI mechanism picker.
CREATE INDEX IF NOT EXISTS idx_script_mechanisms_offers
  ON public.script_mechanisms USING GIN (offer_slugs);
CREATE INDEX IF NOT EXISTS idx_script_mechanisms_angles
  ON public.script_mechanisms USING GIN (angle_slugs);

GRANT SELECT, INSERT, UPDATE ON public.script_mechanisms TO authenticated;
GRANT SELECT ON public.script_mechanisms TO anon;

-- generated_scripts tagging so the history table can show which
-- mechanism was used for each draft. Mirrors the script_type +
-- angle_slug additions from migration 106.
ALTER TABLE public.generated_scripts
  ADD COLUMN IF NOT EXISTS mechanism_slug TEXT
    REFERENCES public.script_mechanisms(slug) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_generated_scripts_mechanism
  ON public.generated_scripts (mechanism_slug);

-- ── Seed the 3 mechanisms already implicit in the angles we've built ──
-- These match the cluster patterns Ben referenced in the accounting
-- bodies: advisory shift, referral chain rebuild, AI ranking.

INSERT INTO public.script_mechanisms
  (slug, name, summary, mechanism_short, mechanism_long, beat_5a, beat_5b, beat_5c,
   offer_slugs, angle_slugs, notes)
VALUES
  ('rank-1-in-ai-restoration',
   'Rank #1 in AI search + Google Maps (restoration)',
   'Foundation + surface + authority signals that put a restoration company at the top of AI search engines and the Maps 3-pack.',
   'rank you #1 in AI for every restoration search in your city',
   'rank you #1 in AI search engines (ChatGPT, Perplexity, Gemini, Google AI Overviews) and the Google Maps 3-pack for every restoration query in your city. We rebuild your Google Business Profile, your service pages, and your authority signals so when a homeowner asks ChatGPT for the best water mit crew in their area, you are the answer it gives',
   'rebuild your Google Business Profile from the ground up with the schema markup and local signals that AI search engines trust when they rank restoration companies',
   'optimize every service page on your website so AI understands exactly what restoration work you do and where you do it',
   'build the authority signals that put you above ServPro and Servicemaster — the citations, structured data, and trust markers AI ranks on',
   ARRAY['opt-restoration']::TEXT[],
   ARRAY['rank-1-in-ai', 'becoming-1-in-city']::TEXT[],
   'Same mechanism currently embedded in the rank-1-in-ai angle. Promoted here so it can be reused across multiple angles for restoration.'),

  ('advisory-shift',
   'Compliance → Advisory Shift',
   'Move a CPA practice off the tax-return treadmill into recurring advisory retainers before commodity software eats the bookkeeping tier.',
   'move your book from compliance to recurring advisory retainers',
   'move your book from one-off compliance work into recurring advisory retainers. We audit your existing client base, identify which clients are upgrade candidates vs which to drop, build the advisory packaging and upsell sequence so the upgrade conversation is easy, and run outbound to backfill freed capacity with mid-market clients Bench and Pilot can''t serve',
   'audit your existing client base + identify upgrade candidates vs drop candidates',
   'build advisory packaging + the upsell sequence that makes the conversation easy and the client say yes',
   'run outbound acquisition to backfill freed capacity with mid-market clients commodity players can''t touch',
   ARRAY['opt-accounting']::TEXT[],
   ARRAY[]::TEXT[],
   'Default mechanism for accounting angles that pair with Bench/Pilot/QBO pain or recurring-advisory desire.'),

  ('referral-chain-rebuild',
   'Banker + Attorney Referral Chain Rebuild',
   'Systematic construction of banker + business-attorney referral chains for accountants — replaces post-COVID broken referral flow.',
   'rebuild your referral chain with the bankers and attorneys who actually drive growth in your city',
   'build a systematic referral chain with the commercial bankers, business attorneys, and wealth managers in your market. We identify the 10 best commercial bankers and 5 best business attorneys in your area, build the value-add content + outreach sequence that gets you on their referral list, and orchestrate the ongoing relationship so referrals compound year over year',
   'identify the 10 best commercial bankers + 5 best business attorneys in your market based on the SMB client volume they actually move',
   'build the value-add content + outreach sequence that gets you on their referral list — white papers, lunch-and-learns, joint webinars',
   'orchestrate the ongoing relationship so referrals compound year over year instead of fading after the first quarter',
   ARRAY['opt-accounting']::TEXT[],
   ARRAY[]::TEXT[],
   'Pairs cleanly with referrals-dried-up problems + banker-chain desires.')
ON CONFLICT (slug) DO UPDATE
  SET name = EXCLUDED.name,
      summary = EXCLUDED.summary,
      mechanism_short = EXCLUDED.mechanism_short,
      mechanism_long = EXCLUDED.mechanism_long,
      beat_5a = EXCLUDED.beat_5a,
      beat_5b = EXCLUDED.beat_5b,
      beat_5c = EXCLUDED.beat_5c,
      offer_slugs = EXCLUDED.offer_slugs,
      angle_slugs = EXCLUDED.angle_slugs,
      notes = EXCLUDED.notes,
      updated_at = NOW();

NOTIFY pgrst, 'reload schema';

COMMIT;
