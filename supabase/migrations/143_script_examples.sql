-- Migration 143: script_examples (winning-ad knowledge base).
--
-- Ben (2026-06-09): "I'm going to give you some script examples from
-- educational scripts that have done well... when you review them and
-- then add them into a knowledge base."
--
-- Why this exists: the Edge Function's educational-mode block currently
-- hand-codes restoration-flavoured examples inline. That biases every
-- run, and we can't update the examples without redeploying the
-- function. With this table:
--   - Ben can paste a new winning ad into the table whenever a creative
--     hits → next script generation references it.
--   - The Edge Function fetches up to 3 examples matching the run's
--     script_mode (educational | direct | hybrid) and prepends them to
--     the prompt as "EXAMPLES TO STUDY (do not copy verbatim)".
--   - Examples can be scoped to a specific offer_slug (e.g. restoration-
--     only) or left global (any offer).
--
-- Idempotent — ON CONFLICT updates the row in place so re-running this
-- migration after we tweak the seed rows just refreshes them.

BEGIN;

CREATE TABLE IF NOT EXISTS public.script_examples (
  slug              TEXT PRIMARY KEY,
  title             TEXT NOT NULL,
  body              TEXT NOT NULL,
  mode              TEXT NOT NULL CHECK (mode IN ('educational', 'direct', 'hybrid')),
  script_type       TEXT NOT NULL CHECK (script_type IN ('hook', 'body', 'hook_body')),
  offer_slug        TEXT,                          -- NULL = applies across offers
  audience_label    TEXT,                          -- e.g. "$25K+/mo local service"
  notes             TEXT,                          -- operator notes: what patterns to study
  source            TEXT,                          -- e.g. "Sentinel transcribe", FB Ad Library URL
  active            BOOLEAN NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_script_examples_mode_active
  ON public.script_examples (mode, active)
  WHERE active = TRUE;

CREATE INDEX IF NOT EXISTS idx_script_examples_offer
  ON public.script_examples (offer_slug)
  WHERE active = TRUE;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.script_examples TO authenticated;
GRANT SELECT ON public.script_examples TO anon;

-- ──────────────────────────────────────────────────────────────────────────
-- Seed the 7 winning educational scripts Ben sent on 2026-06-09.
-- These are all `hook_body` (full hook + body), `educational` mode,
-- and the offer_slug is NULL (cross-offer reference). The variations
-- are intentional — the picker should mix opening shapes across a batch.
-- ──────────────────────────────────────────────────────────────────────────

INSERT INTO public.script_examples (slug, title, body, mode, script_type, offer_slug, audience_label, notes, source) VALUES

('ex-maps-mastery-25k-local',
 'Maps Mastery — $25K+/mo local service (dentist/med-spa/builder)',
 $$Local business owners making over $25,000 a month. This is for you. Google doesn't care about your website anymore. You're wasting thousands on a website no one sees. Here's why that's happening and how to fix it.

Most customers don't click websites anymore. They search on Google and they pick from the top three Google Maps results. If your Google business profile isn't showing up there, you're invisible. That silence you're hearing — it's your leads going to your competitors every single day. I used to think I needed better local SEO or a new website. I spent months updating it. Still got nothing. Then I found out my business wasn't even showing up on Google Maps.

That's why we built the Maps Mastery system. Not just SEO, not ads, just one goal. Rank your business in the top three spots on Google. A dentist in Phoenix went from zero map presence to ranking in the top three in under 30 days and picked up 15 new patients in month one. A med spa doubled their bookings in six weeks — they got nine times more visibility and tripled their reviews after ranking. A building company went from barely any inbound to six times more calls just by hitting number one.

So if you run a local service business doing $25k or more a month and you're tired of paying for SEO that doesn't deliver, click below.$$,
 'educational', 'hook_body', NULL, '$25K+/mo local service (multi-vertical)',
 E'Opens with the qualifier-call-out shape — direct address to the revenue band, then the pattern interrupt: "Google doesn''t care about your website anymore." Note the personal "I used to think..." beat that drops the pitch register for one sentence before the mechanism reveal. Proof characters are 3 named verticals (dentist Phoenix / med spa / building company) with concrete 30d / 6w / 6x outcomes. Mechanism: "Maps Mastery system" (different brand name from "Get Found engine" — keep both alive as variants).',
 'Ben 2026-06-09'),

('ex-get-found-restoration-50k',
 'Get Found Engine — $50K+/mo restoration / water damage / asbestos',
 $$Google's AI doesn't know your business is alive. And that's the real reason you're not getting calls. In 2026, if you run a water damage, fire restoration or asbestos company making over $50,000 a month, Google's AI might be your biggest problem. Not your pricing, not your service, not your competition. Google's AI.

Here's the truth no one talks about. Google's algorithm doesn't think — it guesses. If it hasn't seen proof your business is active, it assumes you're closed and it buries you. No visibility means no calls. No ranking means no jobs. Dead businesses don't get picked.

That's why we built the Get Found engine. It's not PPC. It's not paid leads. It's a system that gives Google what it needs to trust your business is alive. Real signals, real visibility, real results across your Google business profile, your website, and the places that matter.

One client reached number one in just 16 days and booked 18 jobs the very next week. Another went from three calls a week to 27 just by showing Google what it wanted. This isn't guesswork. It's not ads, it's not luck. It's how you survive when Google's AI decides who gets seen and who doesn't.

So if you're tired of being invisible — not because your work is bad, but because Google doesn't know you exist — click the link, book a call. We'll show Google the truth and help your business get the ranking and the calls it deserves.$$,
 'educational', 'hook_body', NULL, '$50K+/mo restoration / water damage / asbestos',
 E'Opens with the pattern-interrupt CLAIM (no qualifier first): "Google''s AI doesn''t know your business is alive." Then DROPS the qualifier in Beat 2 ("if you run a water damage, fire restoration or asbestos company making over $50,000 a month"). The mechanism explanation reframes Google''s algorithm as something that GUESSES — that''s the educational flip the prospect hasn''t heard before. Voice tic to copy: "dead businesses don''t get picked." Same proof set as the other restoration variants (16 days, 18 jobs week; 3 calls/wk → 27). Use this shape when the angle wants a pattern-interrupt open rather than a qualifier-call-out open.',
 'Ben 2026-06-09'),

('ex-legally-stealing-top3-25k',
 'Legally Stealing Top 3 — $25K+/mo service business + guarantee close',
 $$Here's how local businesses are legally stealing the top three Google Maps spots. Google just changed something again. It's using more AI now. If you don't show proof your business is real and active, you vanish. No more set-it-and-forget-it SEO.

Google wants proof. Do you actually service real customers? Can you service people outside of a 1-mile radius? Are you even open anymore? If it doesn't see signs of life, Google buries your business. No map ranking means no calls.

That's why we install the Get Found engine. It's a three-step system built to feed Google what it craves. Real proof, real signals, real authority. And it works fast. I'll guarantee you new top three rankings in days without relying on just paid ads — or you don't pay.

So if this sounds interesting, click the link below, fill out your information and book a call now. If you're wondering how I can offer such a black-and-white guarantee, it's simple. Two reasons. Number one — our results. One client hit number one in just 16 days and booked 18 new customers the week after. Another went from three calls a week to 27. One got booked three weeks solid just from installing the engine. This isn't old-school SEO. This is how Google Maps SEO really works now.

So if you're a service-based business generating more than $25k per month and you want to find out exactly how we guarantee new top 3 rankings, click learn more and book a call now before your business disappears for good.$$,
 'educational', 'hook_body', NULL, '$25K+/mo service business',
 E'Opens with the curiosity-tease hook ("legally stealing"). Distinguishing feature: GUARANTEE-LED close — "I''ll guarantee you new top three rankings in days... or you don''t pay." Then EXPLAINS WHY the guarantee works (the two reasons), which earns the boldness back instead of leaving it as a hollow claim. The "set-it-and-forget-it SEO" phrase is a banned-cliche in the existing prompt''s direct mode, but it works here because the script immediately KILLS it ("no more set-it-and-forget-it"). Use this shape when the offer can credibly back a guarantee.',
 'Ben 2026-06-09'),

('ex-google-changed-something-restoration',
 'Google Changed Something Again — restoration variant',
 $$Google just changed something again. It's using more AI now. If you don't show proof your business is real and active, you vanish. No more set-it-and-forget-it SEO.

Google wants proof. Do you actually service real customers? Can you service people outside of a 1-mile radius? Are you even open anymore? If it doesn't see signs of life, Google buries your business. No map ranking means no calls.

That's why we install the Get Found engine. It's a three-step system built to feed Google what it craves. Real proof, real signals, real authority. And it works fast. I'll guarantee you new top three rankings in days without relying on just paid ads — or you don't pay.

So if this sounds interesting, click the link below, fill out your information and book a call now. If you're wondering how I can offer such a black-and-white guarantee, it's simple. Two reasons. Number one — our results. One client hit number one in just 16 days and booked 18 new customers the week after. Another went from three calls a week to 27. One got booked three weeks solid just from installing the engine. This isn't old-school SEO. This is how Google Maps SEO really works now.

So if you're a local service-based business generating more than $25k per month and you want to find out exactly how we guarantee new top 3 rankings, click learn more and book a call now before your business disappears for good.$$,
 'educational', 'hook_body', NULL, '$25K+/mo local service',
 E'Trend-statement open ("Google just changed something again") — feels like an industry-news take, lower pitch register. Same body + close as ex-legally-stealing-top3-25k. Use this when the angle leans on what''s NEW in 2026 rather than a contrarian reveal.',
 'Ben 2026-06-09'),

('ex-huge-mistake-2026-local',
 'Stop Making This Huge Mistake — $25K+/mo local',
 $$Stop making this huge Google Maps mistake in 2026. The rumors are true. Google uses machine learning to pick which local services show up on the map pack and which ones get left behind. And if you're not keeping up with local SEO correctly, your business might just disappear from search results.

Google doesn't care just about your website anymore. It wants on-the-ground proof. Are you a verified industry expert? Do you really service clients outside of a two-mile radius? It wants to see real location signals. If your Google business profile doesn't have that, the algorithm thinks your business no longer exists.

That's why we install the Get Found engine. It's a three-part automation system built to show Google you're the top-rated authority in your city. If it doesn't see those signals, you're not getting shown and you're not getting customer calls.

One service business we helped ranked number one on Google Maps in 16 days and booked 18 new customers the next week. Another went from three calls a week to 27 after we synced their local SEO signals and proved to Google they were the real deal. Another got booked out three weeks straight just by optimizing their Google listing the right way.

This isn't old-school marketing. This is how Google Maps SEO works in 2026. So if you're a local service provider generating more than $25k per month and you want to see exactly how we guarantee new top 3 rankings, click learn more and book a strategy call now before your business disappears from the map for good.$$,
 'educational', 'hook_body', NULL, '$25K+/mo local service',
 E'Mistake-framing open ("Stop making this huge mistake") — performance pattern: implicates the prospect''s current behavior immediately, so they have to keep watching to learn what the mistake is. Uses the "on-the-ground proof" + "two-mile radius" beat to add specificity (vs the more abstract "real signals" in other variants). Three-PART automation system framing vs three-STEP — minor variation worth keeping for batch variety.',
 'Ben 2026-06-09'),

('ex-legally-rob-top3-25k',
 'Legally Rob the Top 3 — $25K+/mo local (mechanism-first close)',
 $$This is how to legally rob the top three map rankings for your local business. Google just changed how it works. Now it uses AI to pick which businesses show up on Google Maps and which ones get left behind. And if you're not keeping up correctly, your business might just disappear.

Google doesn't care just about your website anymore. It wants proof. Are you an industry expert? Do you really service clients outside of a two-mile radius? It wants to see real proof. If your Google business profile doesn't have that, Google thinks your business is dead. And dead businesses don't get shown.

That's why we install the Get Found engine. It's a three-part system built to show Google you're the real deal. If it doesn't see that, you're not getting shown and you're not getting calls.

One business we helped ranked number one on Google Maps in 16 days and booked 18 new customers the next week. Another went from three calls a week to 27 after we fixed their local SEO and showed Google they were real. Another got booked out three weeks straight just by installing the Get Found engine on their Google listing the right way.

This isn't old-school SEO. This is how Google Maps SEO works now. So if you're a local service-based business generating more than $25k per month and you want to find out exactly how we guarantee new top three rankings, click learn more and book a call now before your business disappears for good.$$,
 'educational', 'hook_body', NULL, '$25K+/mo local service',
 E'Pattern-interrupt + curiosity-trigger open ("legally rob"). Tighter than the "legally stealing" variant — fewer hedges, more declarative beats. Note the parallel-syntax close: "dead businesses don''t get shown" mirrors the earlier "if it doesn''t see that, you''re not getting shown." Good template for a script that wants rhythm rather than hard-sell.',
 'Ben 2026-06-09'),

('ex-google-changed-x-legally-stealing',
 'Google Changed + Legally Stealing (hybrid open)',
 $$Google just changed something again. It's using more AI now. Here's how local businesses are legally stealing the top three Google Maps spots. If you don't show proof your business is real and active, you vanish. No more set-it-and-forget-it SEO.

Google wants proof. Do you actually service real customers? Can you service people outside of a 1-mile radius? Are you even open anymore? If it doesn't see signs of life, Google buries your business. No map ranking means no calls.

That's why we installed the Get Found engine. It's a three-step system built to feed Google what it craves. Real proof, real signals, real authority. And it works fast. I'll guarantee you new top three rankings in days without relying on just paid ads — or you don't pay.

So if this sounds interesting, click the link below, fill out your information and book a call now. If you're wondering how I can offer such a black-and-white guarantee, it's simple. Two reasons. Number one — our results. One client hit number one in just 16 days and booked 18 new customers the week after. Another went from three calls a week to 27. One got booked three weeks solid just from installing the engine. This isn't old-school SEO. This is how Google Maps SEO really works now.

So if you''re a local service-based business generating more than $25k per month and you want to find out exactly how we guarantee new top 3 rankings, click learn more and book a call now before your business disappears for good.$$,
 'educational', 'hook_body', NULL, '$25K+/mo local service',
 E'Stacks TWO opening shapes in the first 3 sentences — trend-statement + curiosity tease — for maximum thumb-stop value before the body. Then collapses back into the standard educational shape from Beat 2 onward. Use this when an angle has TWO equally strong openings and you want to mash them rather than pick.',
 'Ben 2026-06-09')

ON CONFLICT (slug) DO UPDATE
  SET title          = EXCLUDED.title,
      body           = EXCLUDED.body,
      mode           = EXCLUDED.mode,
      script_type    = EXCLUDED.script_type,
      audience_label = EXCLUDED.audience_label,
      notes          = EXCLUDED.notes,
      source         = EXCLUDED.source,
      updated_at     = NOW();

NOTIFY pgrst, 'reload schema';

COMMIT;
