-- Add unique index for WhatConverts lead dedup
-- external_ref will hold the WC lead_id; combined with client_id ensures one row per WC lead per client

create unique index if not exists idx_client_leads_external_ref_per_client
  on client_leads (client_id, external_ref)
  where external_ref is not null;
