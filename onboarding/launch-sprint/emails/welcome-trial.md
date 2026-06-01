# C1 · Welcome Email · Trial Variant

**Trigger:** GHL "trial-signed" tag fires
**Owner sending:** Jonathan
**From address:** jonathan@rankonmaps.io
**Reply-to:** jonathan@rankonmaps.io
**CC:** mersad@rankonmaps.io (internal visibility, not visible to client unless they reply-all)
**Send window:** within 24h of trial signature
**Format:** plain text email with markdown rendering. No HTML template required for v1.

---

## Variables to insert

| Variable | Source | Example |
|----------|--------|---------|
| `{first_name}` | GHL contact field | Stacey |
| `{business_name}` | GHL contact field | New You Health and Wellness |
| `{slug}` | hq.rankonmaps.io client record | new-you-health |
| `{discovery_calendly}` | Jonathan's Calendly + 60-min discovery event | jonathan-rankonmaps/discovery |
| `{slack_invite}` | per-client invite URL from `#rom-{slug}` | https://join.slack.com/... |

---

## Subject

```
Welcome to your Launch Sprint, {first_name}
```

---

## Body

```
Hey {first_name},

Welcome to Rank On Maps. The 14-day Launch Sprint for {business_name} starts today.

Here's the shape of it. Day 14 you get your Ranking Blueprint, a full diagnostic of what's actually happening in your search visibility, AI search, and Maps presence, plus the exact 6-month roadmap to fix it. Between now and then we go deep on the data and on you.

Three things to do right now, in this order:

1. Connect access (5 min)
Open your Launch Sprint portal: https://results.rankonmaps.io/{slug}
Grant us read access to your Google Search Console, Google Analytics, and Google Business Profile. The portal has the click-by-click for each one. Email to grant access to: hello@rankonmaps.com.

2. Book your discovery call (1 min)
This is the 60-minute call where we ask you the questions that shape your entire roadmap. It's recorded so our content team works from your words, not our notes.
Pick a slot: {discovery_calendly}

3. Join your Slack channel (1 min)
Your dedicated channel is where Mersad and I live for the next 14 days. Anything you need, you ask there.
{slack_invite}

That's the only homework. Everything else happens on our end.

What I want you to know about the trial framing:
You committed to 14 days. We committed to delivering something so specific to your business that you'd be foolish to walk away. That's the deal. If we don't earn the next step, the Launch Sprint outputs are yours to keep regardless.

Mersad will be in touch around day 7 with what we're spotting under the hood while we build. So you're not in radio silence.

Any questions, reply here or ping the Slack.

Jonathan

Jonathan [Last Name]
Rank On Maps
jonathan@rankonmaps.io
```

---

## Tone notes

- Lowercase casing on greeting and signoff to match the brand-relaxed register
- No em-dashes, no semicolons, no exclamation marks
- "Hey {first_name}" not "Hi" or "Hello" — warmer, less corporate
- The CTAs are numbered and finite (three things, in this order). Reduces overwhelm
- The trial framing paragraph is the only "sales" language and it leads with the client's commitment, not ours
- Signoff is first name only on the line, full name in the block. Matches how the team actually signs in Slack

---

## Brand alignment

- Launch Sprint and Ranking Blueprint are the canonical names, both used
- No "site sweep", no "audit", no "SEO" as the main framing
- No pricing mentioned (gated rule)
- No 90-day promise (retracted)
- Portal URL convention matches `results.rankonmaps.io/[slug]`
- "AI search and Maps" as the primary product framing, not generic SEO

---

## A/B test variants (optional, post-v1)

- Subject line A: "Welcome to your Launch Sprint, {first_name}"
- Subject line B: "Your Launch Sprint starts today, {first_name}"
- Subject line C: "{first_name}, day 1 of your Launch Sprint"

Once we have ~20 sends, test open rates and lock the winner.

---

## What success looks like

Within 48 hours of this email landing:
- All three CTAs completed (access granted, discovery booked, Slack joined)
- Zero confused replies asking "what is this?"
- Client shows up to the discovery call having done nothing else, which is exactly what we asked for
