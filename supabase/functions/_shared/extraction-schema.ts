// Structured-output JSON schema for the 18-section client extraction.
// Mirrors onboarding_artifacts.section_key enum exactly.
// Sections derived from client-onboarding-questions.md + extended for full
// elite-tier coverage (founder bio, signature specialties, commercial terms,
// stakeholders, photo assets, tracking, initial game-plan).

export const EXTRACTION_SECTIONS = [
  {
    key: 'business_model',
    label: 'Business model & commercial reality',
    instructions: `What does this business actually sell? Packages, pricing, LTV, top-margin services,
capacity constraints, 80/20 of revenue. Specific dollar figures preferred over ranges. If founder said
"average ticket is $12k", use that exact number. If not stated, set [TBC].`,
    schema: {
      packages: { type: 'array', items: 'string', description: 'pricing tiers or service packages' },
      avg_ticket_usd: 'number | "[TBC]"',
      ltv_usd: 'number | "[TBC]"',
      top_two_revenue_services: { type: 'array', items: 'string', description: 'Pareto check' },
      capacity_now: 'string',
      capacity_max: 'string',
      next_bottleneck: 'string',
      cash_pay_vs_insurance: 'string | null',
    },
  },
  {
    key: 'services_catalog',
    label: 'Services in detail',
    instructions: `Every major service the business offers. For each: conditions/use-cases treated,
typical project length, what client experiences in week 1 vs end, honest success rate, contraindications,
cost comparison vs alternatives, brand-name technology/materials used (e.g. "Softwave", "IKO Dynasty"),
strongest testimonial available. Service pages will be built from this — be exhaustive.`,
    schema: {
      services: {
        type: 'array',
        items: {
          name: 'string',
          slug: 'string (kebab-case)',
          treats_or_solves: { type: 'array', items: 'string' },
          process: 'string',
          first_session_feel: 'string',
          end_state_feel: 'string',
          success_rate: 'string | "[TBC]"',
          contraindications: { type: 'array', items: 'string' },
          price_range_usd: 'string',
          materials_or_tech: { type: 'array', items: 'string' },
          testimonial_anchor: 'string | "[TBC]"',
        },
      },
    },
  },
  {
    key: 'customer_profile',
    label: 'Customer / patient profile',
    instructions: `WHO actually walks in the door. Demographics, psychographics, top 3 pain points
in their own words, buying triggers, what makes them disqualify themselves, single most profitable
persona regardless of service.`,
    schema: {
      primary_persona: 'string',
      demographics: 'object',
      pain_points: { type: 'array', items: 'string', minItems: 3, maxItems: 5 },
      buying_triggers: { type: 'array', items: 'string' },
      disqualifiers: { type: 'array', items: 'string' },
      most_profitable_persona: 'string',
    },
  },
  {
    key: 'authority_eeat',
    label: 'E-E-A-T spine',
    instructions: `Years of experience, certifications, awards, licenses, professional memberships,
peer-reviewed publications, media features, manufacturer-level credentials. Each credential MUST
include verification: certification number, issuing body, license number, expiry. AI search
engines weight this heavily.`,
    schema: {
      years_experience: 'integer',
      jobs_completed: 'string',
      certifications: { type: 'array', items: { name: 'string', issuer: 'string', cert_number: 'string | "[TBC]"', tier: 'enum: premium|trust|other' } },
      licenses: { type: 'array', items: { name: 'string', number: 'string', expires: 'date | "[TBC]"' } },
      memberships: { type: 'array', items: 'string' },
      media_features: { type: 'array', items: 'string' },
      awards: { type: 'array', items: 'string' },
    },
  },
  {
    key: 'geography',
    label: 'Geography & service area',
    instructions: `Granular. Primary city, region descriptor (Hill Country, Sonoran Desert), state,
service radius in miles, specific counties, named neighborhoods (especially affluent / historic /
target zones). Used to build area landing pages.`,
    schema: {
      primary_city: 'string',
      region: 'string',
      region_descriptor: 'string',
      state_long: 'string',
      state_abbr: 'string (2 chars)',
      metro_label: 'string',
      service_radius_miles: 'integer',
      primary_counties: { type: 'array', items: 'string' },
      signature_neighborhoods: { type: 'array', items: 'string' },
      suburb_cities: { type: 'array', items: 'string', minItems: 3 },
    },
  },
  {
    key: 'existing_assets',
    label: 'Existing content & assets to mine',
    instructions: `What do they ALREADY have that we can use: existing website URL, blog posts,
case studies, photo library size, video library, social media presence, CompanyCam or similar
job-photo tool, brand kit, testimonials, before/afters. Note what's missing.`,
    schema: {
      current_site_url: 'string | null',
      blog_post_count: 'integer | "[TBC]"',
      case_study_count: 'integer | "[TBC]"',
      photo_library: 'string (description + estimated count)',
      video_library: 'string',
      social_handles: 'object (platform → url)',
      brand_kit_status: 'enum: full|partial|none|"[TBC]"',
      written_testimonials_count: 'integer | "[TBC]"',
      gaps: { type: 'array', items: 'string' },
    },
  },
  {
    key: 'competitors',
    label: 'Competitive landscape',
    instructions: `Who they actually lose deals to (named businesses, not generic "other roofers").
What advantage those competitors hold: review count, citation count, manufacturer relationship,
brand recognition, price, speed. Then: where THIS client wins vs each. Each named competitor
should have a one-line gap analysis.`,
    schema: {
      direct_competitors: {
        type: 'array',
        items: {
          name: 'string',
          their_advantage: 'string',
          our_advantage: 'string',
          gap_to_close: 'string',
        },
        minItems: 3, maxItems: 6,
      },
      indirect_competitors: { type: 'array', items: 'string' },
    },
  },
  {
    key: 'conversion_mechanics',
    label: 'Conversion & sales mechanics',
    instructions: `How do they actually close deals today? Lead-to-quote rate, quote-to-close rate,
average sales cycle, who runs the sales call, what tools they use (CRM, calendar, payment),
what objections kill deals. We need ALL the numbers to calculate ROI.`,
    schema: {
      qualified_rate_pct: 'number 0-1 | "[TBC]"',
      close_rate_pct: 'number 0-1 | "[TBC]"',
      avg_sales_cycle_days: 'integer | "[TBC]"',
      crm: 'string | null',
      calendar_tool: 'string | null',
      sales_runner: 'string',
      top_objections: { type: 'array', items: 'string' },
      payment_terms: 'string',
      tracking_status: 'enum: full|partial|none',
    },
  },
  {
    key: 'compliance',
    label: 'Compliance & legal landmines',
    instructions: `What CAN'T they say? Industry regulations (HIPAA for medical/dental, bar rules
for legal, FTC for HVAC efficiency claims, insurance regulator for roofing). Specific claims they
need to avoid. Any past compliance incidents. Disclaimers required on website.`,
    schema: {
      vertical_regulators: { type: 'array', items: 'string' },
      forbidden_claims: { type: 'array', items: 'string' },
      required_disclaimers: { type: 'array', items: 'string' },
      past_incidents: 'string | null',
      bbb_status: 'enum: accredited|listed|none|"[TBC]"',
      bbb_rating: 'string | "[TBC]"',
    },
  },
  {
    key: 'brand_voice',
    label: 'Brand voice & the human',
    instructions: `5 adjectives describing how the brand should sound. Vocabulary they use vs avoid.
Their personality. Tone for emergency vs casual content. If voice on the sales call was casual +
self-deprecating, capture that. If it was authoritative + clinical, capture that too.`,
    schema: {
      five_adjectives: { type: 'array', items: 'string', minItems: 5, maxItems: 5 },
      vocabulary_use: { type: 'array', items: 'string' },
      vocabulary_avoid: { type: 'array', items: 'string' },
      emergency_tone: 'string',
      casual_tone: 'string',
      formality: 'enum: highly-formal|professional|casual|conversational',
      humor: 'enum: none|dry|warm|self-deprecating',
    },
  },
  {
    key: 'logistics',
    label: 'Wrap-up logistics',
    instructions: `Domain ownership, current hosting, email setup, GA4/GSC access, social account
ownership, photo storage access, payment processor used. Practical stuff we need on Day 1.`,
    schema: {
      domain_registrar: 'string | "[TBC]"',
      current_hosting: 'string | "[TBC]"',
      email_provider: 'string | "[TBC]"',
      ga4_access: 'boolean',
      gsc_access: 'boolean',
      social_admin_owner: 'string',
      photo_storage: 'string',
      payment_processor: 'string',
    },
  },
  {
    key: 'founder_bio',
    label: 'Founder deep bio',
    instructions: `Founder's actual story. Started at age X, what trade/profession before, what
made them go independent, signature method/technique that separates them, what they personally
do on every job vs what they delegate. 220-word long-form bio + 80-word short bio + 6 signature
skills. Specific, vivid, named entities only.`,
    schema: {
      first_name: 'string',
      full_name: 'string',
      title: 'string',
      started_age: 'integer',
      current_age: 'integer | "[TBC]"',
      years_experience: 'integer',
      bio_short: 'string (60-80 words)',
      bio_long: 'string (180-220 words)',
      signature_skills: { type: 'array', items: 'string', minItems: 6, maxItems: 6 },
      what_they_personally_do: { type: 'array', items: 'string' },
    },
  },
  {
    key: 'signature_specialties',
    label: 'Signature specialties (elite differentiators)',
    instructions: `2-4 things this business does that almost no competitor does at the same level.
Each gets a specialty card on the website. Name it specifically (not "high quality work" — name
the technique: "Hand-built copper chimney crickets"), describe in 40-60 words what makes it elite.`,
    schema: {
      specialties: {
        type: 'array',
        items: {
          name: 'string',
          summary: 'string (40-60 words)',
          anchor: 'string (kebab-case)',
        },
        minItems: 2, maxItems: 4,
      },
    },
  },
  {
    key: 'commercial_terms',
    label: 'Commercial terms with ROM',
    instructions: `What did the closer agree to with this client? Monthly fee, tier (maps_only,
full_stack, custom, retainer_only), trial path (trial=14d trial / direct=ongoing immediately),
contract start, contract end if known, special terms or discounts negotiated.`,
    schema: {
      monthly_fee_usd: 'number',
      tier: 'enum: maps_only|full_stack|custom|retainer_only',
      path: 'enum: trial|direct',
      trial_length_days: 'integer | null',
      contract_start: 'date',
      contract_end: 'date | null',
      special_terms: 'string | null',
    },
  },
  {
    key: 'stakeholders',
    label: 'Decision-makers & comms routing',
    instructions: `Who all is involved on the client side? Owner, office manager, marketing lead,
billing contact. For each: name, email, phone, preferred channel (slack/email/sms/call), what
topics they should be CC'd on vs not, decision authority.`,
    schema: {
      stakeholders: {
        type: 'array',
        items: {
          name: 'string',
          role: 'enum: owner|office_manager|marketing_lead|technical_contact|billing_contact|other',
          email: 'string',
          phone: 'string',
          preferred_channel: 'enum: slack|email|sms|call',
          cc_on: { type: 'array', items: 'string' },
          not_cc_on: { type: 'array', items: 'string' },
          decision_authority: 'enum: full|operational|informed_only',
          is_primary: 'boolean',
        },
      },
    },
  },
  {
    key: 'photo_assets',
    label: 'Photos: what exists, what we need',
    instructions: `What photo coverage exists today: founder portrait, team shot, branded vehicle,
recent job photos (count + format + quality), before/after pairs, lifestyle shots. What's missing
that we'd ideally have. Note if they use CompanyCam.`,
    schema: {
      founder_portrait: 'enum: have|need|"[TBC]"',
      team_shot: 'enum: have|need|"[TBC]"',
      branded_vehicle: 'enum: have|need|"[TBC]"',
      job_photo_count: 'integer | "[TBC]"',
      job_photo_quality: 'enum: pro|mixed|phone-only|"[TBC]"',
      before_after_pairs: 'integer | "[TBC]"',
      uses_companycam: 'boolean',
      gaps: { type: 'array', items: 'string' },
    },
  },
  {
    key: 'tracking_setup',
    label: 'Existing tracking infrastructure',
    instructions: `Current state of measurement. GA4 ID if they have one. Google Search Console
verified domain. WhatConverts or other call-tracking. Phone numbers currently in use. CRM
integration possibilities.`,
    schema: {
      ga4_measurement_id: 'string | null',
      gsc_verified_domain: 'string | null',
      whatconverts_active: 'boolean',
      call_tracking_tool: 'string | null',
      current_phone_numbers: { type: 'array', items: 'string' },
      crm_with_api: 'enum: yes|no|"[TBC]"',
      tracking_tier: 'enum: T1_full|T2_crm_api|T3_manual|T4_benchmark',
    },
  },
  {
    key: 'initial_gameplan',
    label: 'Initial 90-day game plan',
    instructions: `Based on EVERYTHING extracted, the strategic move. Top 3 priorities for week 1
(launch site, optimize GBP, start review velocity). Top 3 priorities for month 1. Top 3 for month
3. The big gap-to-competitor that we close, framed as a measurable target.`,
    schema: {
      week_1_priorities: { type: 'array', items: 'string', minItems: 3, maxItems: 3 },
      month_1_priorities: { type: 'array', items: 'string', minItems: 3, maxItems: 3 },
      month_3_priorities: { type: 'array', items: 'string', minItems: 3, maxItems: 3 },
      gap_to_close: 'string',
      ninety_day_target: 'string',
      lead_indicator: 'string',
    },
  },
] as const

export type SectionKey = typeof EXTRACTION_SECTIONS[number]['key']
