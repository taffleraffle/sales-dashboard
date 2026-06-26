import { Eyebrow, ValueChip, attrColor, displayValue } from '../editorial/atoms'
import Modal from '../editorial/Modal'

/*
  Right-side slide drawer documenting every attribute name + value so the
  operator never has to wonder what "Mechanism reveal" or "Capacity Mismatch"
  means. Surfaces the locked vocabulary from creative_attribute_vocab + the
  testing-methodology context that's only in Ben's head right now.
*/

const ATTRIBUTES = [
  {
    id: 'hook_type',
    label: 'Hook type',
    what: 'The opening seconds of the ad — what shape it takes.',
    why: "Hook is the single biggest predictor of watch-time. We test which hook style lands hardest with restoration-company owners.",
    values: [
      { v: 'question',     desc: 'Direct question to the viewer ("Are you losing leads to TPAs?")' },
      { v: 'scene',        desc: 'Cinematic scene-set ("Imagine your phone ringing every hour...")' },
      { v: 'dollar_pain',  desc: 'Specific money number ("You\'re leaving $40k/month on the table")' },
      { v: 'diagnostic',   desc: 'Diagnose the problem ("If your booked rate is below 30%, here\'s why")' },
      { v: 'conditional',  desc: 'If-then framing ("If you\'re doing $50k/month, this is your next move")' },
    ],
  },
  {
    id: 'message_frame',
    label: 'Message frame',
    what: 'The lens the ad uses to position the offer.',
    why: 'Framing determines who self-identifies with the ad. The three frames pull different prospects.',
    values: [
      { v: 'problem',      desc: 'Lead with the pain — what\'s broken, what\'s costing them' },
      { v: 'circumstance', desc: 'Lead with the situation — where they are right now' },
      { v: 'outcome',      desc: 'Lead with the result — what they\'ll have after working with us' },
    ],
  },
  {
    id: 'mechanism_reveal',
    label: 'Mechanism reveal',
    what: 'How explicitly the ad names our system / how we do it.',
    why: 'Sultanic Truth-vs-Trust testing — does naming the mechanism (Direct Call Engine) build trust, or does keeping it gated build curiosity?',
    values: [
      { v: 'gated',     desc: 'Mechanism is named with a brand label (e.g. "The Direct Call Engine")' },
      { v: 'explicit',  desc: 'Mechanism is literally described (e.g. "we book your calls directly")' },
      { v: 'hidden',    desc: 'Outcome only, no mention of how' },
    ],
  },
  {
    id: 'pain_angle',
    label: 'Pain angle',
    what: 'The specific operator wound the ad presses on.',
    why: '14 known pain points across restoration owners. Different angles work for different awareness levels and funnel stages.',
    values: [
      { v: 'phone_not_ringing',   desc: 'Lead-volume problem — phone is dead' },
      { v: 'agency_burn',         desc: 'Burned by previous SEO/marketing agency' },
      { v: 'tpa_referral_dep',    desc: 'Dependent on TPA referrals (Servpro, Belfor)' },
      { v: 'capacity_mismatch',   desc: 'Have crews but no jobs / jobs but no crews' },
      { v: 'lead_platform',       desc: 'Bad leads from Angi/HomeAdvisor/Networx' },
      { v: 'storm_seasonal',      desc: 'Storm season prep / off-season slowdown' },
      { v: 'guarantee_proof',     desc: 'Need proof we can guarantee results' },
      { v: 'founder_identity',    desc: 'Founder self-image — "I built this from nothing"' },
      { v: 'adjuster_relations',  desc: 'Insurance adjuster relationship management' },
      { v: 'commercial_tier',     desc: 'Trying to move from residential to commercial' },
      { v: 'last_objection',      desc: 'Closing-the-deal objection handling' },
      { v: 'speed_timeline',      desc: 'Speed-to-result expectations' },
    ],
  },
  {
    id: 'awareness_level',
    label: 'Awareness level',
    what: "Schwartz's 5 stages of buyer awareness.",
    why: 'The hook must match the prospect\'s lowest awareness axis. Most owners are problem-aware about lead flow but unaware that named mechanisms exist.',
    values: [
      { v: 'unaware',          desc: "Doesn't yet know they have the problem" },
      { v: 'problem_aware',    desc: 'Knows the problem exists, no solution category yet' },
      { v: 'solution_aware',   desc: 'Knows solutions exist (SEO, ads, paid leads) but not our specific approach' },
      { v: 'product_aware',    desc: 'Knows OPT exists, evaluating' },
      { v: 'most_aware',       desc: 'Ready to buy, just needs the trigger' },
    ],
  },
]
// Trimmed 2026-05-18: dropped funnel_stage, length_bucket, format,
// proof_character, actor, vertical. The data columns still exist for
// historical rows; we just don't tag/test on them anymore.

const STATUS_TERMS = [
  { term: 'Winner',
    desc: 'Ad with ≥$1,000 spend AND ≥2 booked calls AND cost-per-booked ≤$300. Auto-detected — can be manually overridden per ad.' },
  { term: 'Win rate',
    desc: 'Winners divided by tagged ads. Baseline for "Variables pulling ahead" lift calculations.' },
  { term: 'CPB',
    desc: 'Cost per booked call. Spend ÷ booked. The single metric that decides winners.' },
  { term: 'Lift',
    desc: 'How much an attribute value beats baseline win rate (percentage points, not %).' },
  { term: 'Assigned',
    desc: 'Ad is linked to a generated_scripts row (we know which script produced it).' },
  { term: 'Manual / Auto / Ad copy only',
    desc: 'Transcript source. Manual = operator typed it. Auto = Whisper/Meta captions. Ad copy only = just headline+body, no real transcript.' },
  { term: 'Unassigned',
    desc: 'No script link AND no real transcript. These are the rows that need attention.' },
]

export default function GlossaryDrawer({ open, onClose }) {
  return (
    <Modal open={open} onClose={onClose} size="lg"
      eyebrow="Reference"
      title="Glossary — what every tag means"
    >
        <div style={{ padding: '24px 28px 32px' }}>
          {/* Intro */}
          <p style={{
            fontFamily: 'var(--sans)', fontSize: 13, color: 'var(--ink-3)',
            lineHeight: 1.55, marginTop: 0,
          }}>
            Every ad is classified across 11 dimensions so we can pivot on what's
            actually driving wins. Tags come from Claude reading the transcript +
            ad copy. Below: what each dimension means, what its values mean, and
            why we test it.
          </p>

          {/* Status terms first — they appear in every column */}
          <section style={{ marginTop: 28, marginBottom: 32 }}>
            <Eyebrow style={{ marginBottom: 10 }}>Status terms</Eyebrow>
            <div style={{
              background: 'var(--paper)', border: '1px solid var(--rule)',
            }}>
              {STATUS_TERMS.map((t, i) => (
                <div key={t.term} style={{
                  padding: '12px 14px',
                  borderTop: i === 0 ? 'none' : '1px solid var(--rule)',
                }}>
                  <div style={{
                    fontFamily: 'var(--sans)', fontSize: 13, fontWeight: 600, color: 'var(--ink)',
                  }}>{t.term}</div>
                  <div style={{
                    fontFamily: 'var(--sans)', fontSize: 12, color: 'var(--ink-3)',
                    marginTop: 2, lineHeight: 1.5,
                  }}>{t.desc}</div>
                </div>
              ))}
            </div>
          </section>

          {/* Each attribute */}
          {ATTRIBUTES.map(a => (
            <section key={a.id} style={{ marginBottom: 28 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 4 }}>
                <h3 style={{
                  margin: 0, fontFamily: 'var(--sans)', fontSize: 15, fontWeight: 600,
                  color: 'var(--ink)',
                }}>{a.label}</h3>
                <span style={{
                  fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-4)',
                  letterSpacing: '0.04em',
                }}>{a.id}</span>
              </div>
              <p style={{
                margin: '4px 0 6px', fontFamily: 'var(--sans)', fontSize: 13,
                color: 'var(--ink-2)', lineHeight: 1.5,
              }}>{a.what}</p>
              <p style={{
                margin: '0 0 10px', fontFamily: 'var(--sans)', fontSize: 12,
                fontStyle: 'italic', color: 'var(--ink-4)', lineHeight: 1.5,
              }}>Why we test: {a.why}</p>

              <div style={{ background: 'var(--paper)', border: '1px solid var(--rule)' }}>
                {a.values.map((vv, i) => (
                  <div key={vv.v} style={{
                    display: 'grid', gridTemplateColumns: 'auto 1fr', gap: 12,
                    padding: '10px 14px',
                    borderTop: i === 0 ? 'none' : '1px solid var(--rule)',
                    alignItems: 'baseline',
                  }}>
                    <ValueChip attr={a.id} value={vv.v} size="xs" />
                    <span style={{
                      fontFamily: 'var(--sans)', fontSize: 12, color: 'var(--ink-3)',
                      lineHeight: 1.5,
                    }}>{vv.desc}</span>
                  </div>
                ))}
              </div>
            </section>
          ))}

          {/* Footer link */}
          <div style={{
            marginTop: 32, padding: '14px 16px',
            background: 'var(--paper-2)',
            border: '1px solid var(--rule)',
            fontFamily: 'var(--sans)', fontSize: 12, color: 'var(--ink-3)',
            lineHeight: 1.5,
          }}>
            <strong style={{ color: 'var(--ink)' }}>Authoritative source:</strong>{' '}
            this glossary mirrors{' '}
            <code style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>
              public.creative_attribute_vocab
            </code>{' '}
            in Supabase. Adding a new value? Insert there first; this drawer
            renders from the locked vocab so the dropdown options on the edit
            drawer stay aligned.
          </div>
        </div>
    </Modal>
  )
}
