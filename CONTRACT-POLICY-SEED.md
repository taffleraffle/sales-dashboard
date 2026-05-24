# Contract Amendment Policy — Seed Doc

Generated from 12-rule policy session, 2026-05-24. Paste the body of this file
into the Contract Policy editor at `/sales/contracts/policy` once Sentinel has
run migration 015. The AI judge engine (phase 3) reads this verbatim when
evaluating amendment requests from closers.

---

# OPT Digital Contract Amendment Policy

When a closer submits an amendment request, classify it as **ALLOW** (auto-apply),
**REVIEW** (escalate to Ben), or **BLOCK** (auto-reject). Use this rulebook as
the source of truth.

## ALLOW — auto-apply these changes

**IP vesting on creation (day 1).** Client can own Developed IP from day 1 INSTEAD
of on contract completion. MANDATORY addition: insert clause "GMB profiles
created by Opt Digital remain the property of Opt Digital." Without that carve-
out, downgrade to REVIEW.

**Indemnity narrowing to wilful misconduct / gross negligence only.** Client
indemnifies us only for wilful misconduct or gross negligence, not ordinary
negligence. Standard market ask.

**Geographic exclusivity at 20%+ premium.** Client locks us out of competing
businesses in their service area (50-mile radius typical) for duration of
engagement, in exchange for 20%+ monthly fee premium. Below 20% premium or
category-wide exclusivity → REVIEW.

**Dishonour fee waiver ($7 → $0).** Removing the flat $7 dishonour fee is fine.
Pass-through Stripe charges still apply.

**Late-payment 5-day grace period.** 5 business-day grace before the 20%
interest rate kicks in.

**Cancellation notice 30 days → 14 days.** Allowed BUT the "no pro-rata refund"
language must be explicitly preserved. If the request bundles a pro-rata refund
ask, downgrade to BLOCK.

**Termination for convenience (7-day notice).** Client can walk on 7 days
notice IF these terms are preserved: paid invoices owed, guarantees forfeited,
no refund of fees already paid, hosting invoice still owed for any websites
OPT continues to host. If the request bundles a refund trigger or
satisfaction-based cancellation, downgrade to BLOCK.

**Suspension-for-non-payment clause removal.** OK to remove our right to
suspend services on late payment. Late-payment interest + collection-cost
language stays.

**Spelling, contact info, addressee corrections.** Auto-apply.

**Adding specific target keywords to scope.** Auto-apply.

## REVIEW — escalate to Ben via dashboard inbox + Slack DM

**Direct Debit removal.** Switching from Direct Debit to manual invoice/ACH.
The unlock is pre-payment (typically quarterly minimum). If the request
explicitly includes pre-pay language, auto-apply. Otherwise escalate.

**E&O insurance requirement on OPT.** Don't commit by default; escalate
because we may already carry sufficient coverage and the answer depends on
what's already in place.

**Auto-renewal opt-in CONSENT GATE (vs courtesy notification).** A heads-up
email before first recurring charge is auto-applied. An affirmative-consent
gate ("client must click to confirm") is REVIEW.

**Exclusivity below 20% premium or category-wide.** Below 20% or category-wide
exclusivity needs human judgement on opportunity cost.

**Old-template 90-day Guarantee — stripping DBA requirement.** If the request
keeps the DBA requirement and only waives photos/reviews, auto-apply. If the
request strips the DBA, escalate (likely BLOCK).

**Anything that bundles a small reasonable ask with a refund-trigger.** E.g.
"add monthly reports + missed report = refund." The reporting commitment is
BLOCK; if a closer is trying to negotiate the bundle, escalate so I can decide
whether to keep one half.

## BLOCK — auto-reject, no escalation path

**Jurisdiction change away from New Zealand.** Governing law stays NZ regardless
of where the client is based. Hard rule.

**Liability cap above 6 months of fees.** 6-month cap is non-negotiable, even
on enterprise asks for 12-month caps.

**Contractual performance-reporting obligation tied to refunds.** Reports stay
best-effort. Any "missed report = refund" mechanic is a backdoor cancellation
trigger.

**Subcontractor approval right or vendor name disclosure.** Existing unilateral
subcontracting consent stays. No notice, no approval right, no vendor names
disclosed. Our fulfilment stack is competitive IP.

**Removal of auto-renewal entirely / full opt-in re-signing each month.**
The trial-to-retainer mechanic depends on auto-continuation. Courtesy
notifications OK; consent gates aren't.

**Satisfaction-based cancellation with refund.** "Client may cancel if
unsatisfied and receive refund" is the AquaFlame trap. Any clause where
subjective dissatisfaction triggers monetary remedy is blocked.

**IP vesting on creation WITHOUT the GMB carve-out.** The GMB-retention
language is mandatory. Without it, block.

**Indefinite work-for-free guarantees.** All continued-service guarantees must
cap at 90 days (per the original Client Terms Clause 4d). Any "we keep working
until you're happy" with no end date is blocked.

**Disclosure of backlink vendors, contractor identities, or methodology.**
None of our fulfilment IP leaves the building.

**Removal of Direct Debit WITHOUT pre-pay commitment.** Direct Debit stays
unless client commits to pre-payment minimum.

---

## Meta-principle for grey-area calls

When a request feels reasonable in isolation but the *combination* with another
clause creates a trap (e.g. "weekly reports" + "missed report = refund" + "DD
revoked"), block the bundle and escalate so we can decide which half to keep.
The closer's job is to surface deal-shape questions early, not negotiate
chip-by-chip.
