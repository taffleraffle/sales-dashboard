# C2 · Welcome Email · Full-Commit Variant

**Trigger:** GHL "full-retainer-signed" tag fires (signed direct, no trial)
**Owner sending:** Jonathan
**From address:** jonathan@rankonmaps.io
**Reply-to:** jonathan@rankonmaps.io
**CC:** mersad@rankonmaps.io
**Send window:** within 24h of contract signature
**Format:** plain text email with markdown rendering

---

## Variables to insert

| Variable | Source | Example |
|----------|--------|---------|
| `{first_name}` | GHL contact field | Stacey |
| `{business_name}` | GHL contact field | New You Health and Wellness |
| `{slug}` | hq.rankonmaps.io client record | new-you-health |
| `{discovery_calendry}` | Jonathan's Calendly + 60-min discovery event | jonathan-rankonmaps/discovery |
| `{slack_invite}` | per-client invite URL | https://join.slack.com/... |
| `{engagement_tier}` | from signed agreement (Maps-only or Full-Stack) | Full-Stack |

---

## Subject

```
Welcome to Rank On Maps, {first_name}. Here's your Launch Sprint.
```

---

## Body

```
Hey {first_name},

Welcome aboard. Now that {business_name} is on the {engagement_tier} engagement, the next 14 days are your Launch Sprint. This is where we lay the foundation that everything in the months ahead is built on.

The deliverable at day 14 is your Ranking Blueprint, a full diagnostic of where you sit today in search visibility, AI search, and Maps, plus the exact 6-month roadmap that becomes the canonical strategy doc for our work together. Every page we build, every link we earn, every Map Pack move from month one onward traces back to this.

Three things to do right now, in this order:

1. Connect access (5 min)
Open your Launch Sprint portal: https://results.rankonmaps.io/{slug}
Grant us read access to your Google Search Console, Google Analytics, and Google Business Profile. The portal has the click-by-click for each one. Email to grant access to: hello@rankonmaps.com.

2. Book your discovery call (1 min)
This is the 60-minute call where we ask you the questions that shape the entire 6-month roadmap. It's recorded so our content team works from your words, not our notes.
Pick a slot: {discovery_calendry}

3. Join your Slack channel (1 min)
Your dedicated channel is where Mersad and I live day-to-day. Anything you need, you ask there.
{slack_invite}

That's the only homework for now. Everything else happens on our end.

What month one looks like beyond day 14:
Once the Launch Sprint delivers, we walk you through the Ranking Blueprint on a 30-minute call and lock priorities for month one. From there execution begins immediately. The Blueprint stays your source of truth for the full engagement, updated as the work compounds.

Mersad will be in touch around day 7 with what we're spotting under the hood while we build. So you're not in radio silence.

Any questions, reply here or ping the Slack.

Jonathan

Jonathan [Last Name]
Rank On Maps
jonathan@rankonmaps.io
```

---

## How this differs from C1 (trial variant)

| Element | C1 trial | C2 full |
|---------|----------|---------|
| Subject | "Welcome to your Launch Sprint" | "Welcome to Rank On Maps. Here's your Launch Sprint." |
| Opening line | "The 14-day Launch Sprint starts today" | "Now that you're on the {tier} engagement, the next 14 days are your Launch Sprint" |
| Trial-specific paragraph | "You committed to 14 days. We committed to..." | Replaced with "What month one looks like beyond day 14" |
| Forward framing | "If we don't earn the next step..." | "The Blueprint stays your source of truth for the full engagement" |
| Closing tone | Confident invitation to continue | Confident assumption that this is the beginning of execution |

Everything else identical. Same three CTAs, same portal URL, same Mersad day-7 promise, same signoff style.

---

## Tone notes

- Same lowercase greeting + signoff register as C1
- No em-dashes, no semicolons, no exclamation marks
- The forward-looking paragraph replaces the trial commitment paragraph. Don't double up
- `{engagement_tier}` is named once so the client feels the contract is acknowledged without belabouring it
- "Source of truth" framing positions the Blueprint as a strategic asset, not just an audit deliverable

---

## Brand alignment

- Launch Sprint and Ranking Blueprint are the canonical names
- No "site sweep", no "audit", no "SEO" as the main framing
- "AI search and Maps" as the primary product framing
- No specific dollar pricing (gated rule)
- No 90-day promise (retracted)
- Engagement tier named but never priced in the email

---

## Edge case · client signs full-commit AFTER completing a trial

If a client converts from trial to full mid-Launch-Sprint (rare, but possible), do NOT resend either welcome email. Instead, post in their Slack channel:

```
{first_name}, you're now on the {tier} engagement. Same Launch Sprint, same day-14 Blueprint, just executed within the bigger 6-month frame. We'll talk priorities for month one on the presentation call.
```

Update their GHL tag from "trial-signed" to "full-retainer-signed" so future automation fires the right variant.

---

## What success looks like

Within 48 hours of this email landing:
- All three CTAs completed
- Zero confusion about what they signed up for
- Client shows up to the discovery call having done nothing else, which is exactly what we asked for
- Mersad has GSC/GA/GBP access verified and data pull is queued
