# Low-Quality Creative Library Replacement List

Source: `preview-audit.csv` (HEAD-probed snapshot, may not reflect current DB state).
Re-run `node scripts/audit-preview-file-sizes.mjs` before bulk action to confirm.

**Totals:** 84 of 88 audited rows need replacement.
- `BROKEN_PLACEHOLDER` (actual < 3 MB) — 26 rows. Truncated download, unplayable.
- `SUB_PAR` (bitrate < 4 Mbps) — 58 rows. Plays but WhatsApp-call quality.
- `OK` — 4 rows (excluded from this list).

URL pattern (predicted — confirm with DB):
`https://kjfaqhmllagbxjdxlopm.supabase.co/storage/v1/object/public/creative-uploads/previews/<filename>`

To get the **actual** URLs straight from the DB, run this in Supabase SQL editor:

```sql
SELECT id,
       COALESCE(canonical_name, name) AS name,
       type,
       preview_url,
       preview_url || '?download=' || COALESCE(canonical_name, name) AS download_url,
       low_quality_reason,
       low_quality_actual_mb
FROM lib_creative_library
WHERE is_low_quality = true
ORDER BY low_quality_reason, name;
```

---

## BROKEN_PLACEHOLDER (26 rows — top priority, completely unusable)

| # | ID | Name | Actual MB | Has Drive |
|---|----|----- |-----------|-----------|
| 1 | `b8567aae-46ff-4aa7-a5e0-877e3cce18f1` | FULL-UNK-RESTORATIONLEADG-T01.mp4 | 1.04 | no |
| 2 | `5487bff3-fd0a-48b4-83c8-9227f8f850fc` | BODY-UNK-SEOLEADSFORTRADE-T01.mp4 | 1.35 | no |
| 3 | `8815daa6-5fce-43df-8016-df6b727f3dd2` | BODY-UNK-ACTUALRESULTSMAR-T01.mp4 | 1.24 | no |
| 4 | `02aafd8c-db64-45a1-95a5-dd190d3a76d4` | JOINED-OSO-ERIC-GOOGLERANKINGRES-T01.mp4 | 2.12 | no |
| 5 | `20895ebd-a809-4e89-8af3-62ec0263ddbc` | JOINED-OSO-ERIC-GOOGLERANKINGRES-T02.mp4 | 2.04 | no |
| 6 | `4b28008d-c821-4701-9c3a-2473668d7fcd` | JOINED-OSO-ADAM-GOOGLERANKINGGUA-T01.mp4 | 2.17 | no |
| 7 | `eb76ba72-12dc-440e-b96e-b85e1751ac69` | JOINED-OSO-ADAM-GOOGLERANKINGRES-T03.mp4 | 2.05 | no |
| 8 | `af640dd1-6308-49fc-af67-94e1f3bea89b` | JOINED-OSO-ERIC-GOOGLERANKINGFOR-T01.mp4 | 2.14 | no |
| 9 | `67301d93-d9ff-4a09-86ad-c1745d37d03a` | JOINED-OSO-ERIC-GOOGLERANKINGRES-T03.mp4 | 2.06 | no |
| 10 | `25cc2545-7ff2-4772-b771-58052537ab60` | JOINED-OSO-ADAM-GOOGLERANKINGRES-T01.mp4 | 2.15 | no |
| 11 | `36c26dad-5c8c-4193-9800-8348ee1e01a2` | JOINED-OSO-ADAM-GOOGLERANKINGRES-T02.mp4 | 2.05 | no |
| 12 | `b1eba840-717d-487b-a0c0-674f0167846e` | JOINED-OSO-ERIC-GOOGLERANKINGFOR-T02.mp4 | 1.99 | no |
| 13 | `483c4c5d-04cf-455f-be3b-b8d2e17aeccf` | JOINED-NATALIE-ERIC-GOOGLERANKINGGUA-T01.mp4 | 1.70 | no |
| 14 | `a5527642-1610-4fce-aa2a-1fa8a2599e8f` | JOINED-NATALIE-ERIC-GOOGLERANKINGSIG-T01.mp4 | 1.61 | no |
| 15 | `58feb157-02f2-416e-8f56-3b4734739a35` | JOINED-NATALIE-ADAM-GOOGLERANKINGGUA-T01.mp4 | 1.69 | no |
| 16 | `c5fd61d4-3019-46b8-b7eb-6a98cd5993bf` | JOINED-NATALIE-ADAM-GOOGLERANKINGRES-T02.mp4 | 1.59 | no |
| 17 | `638fe4c8-3db2-4588-b1bc-247bd5199b66` | JOINED-NATALIE-ERIC-GOOGLERANKINGRES-T01.mp4 | 1.63 | no |
| 18 | `96c61afd-958a-4257-b0af-378e79651645` | JOINED-NATALIE-ERIC-GOOGLERANKINGGUA-T03.mp4 | 1.60 | no |
| 19 | `a0e99d56-abdc-4538-84b3-4913ee4a1f89` | JOINED-NATALIE-ADAM-GOOGLERANKINGRES-T01.mp4 | 1.66 | no |
| 20 | `d17ce285-69cc-45e7-a90a-c501b108ecf3` | JOINED-NATALIE-ADAM-GOOGLERANKINGRES-T03.mp4 | 1.54 | no |
| 21 | `7b8c47e7-28a6-492f-88ac-508c811bdda6` | JOINED-NATALIE-ERIC-GOOGLERANKINGGUA-T02.mp4 | 1.62 | no |
| 22 | `7cc29c2d-b0a2-44c7-a040-c9f6e8113e90` | JOINED-AIRESTO-ERIC-GOOGLEDIRECTCALL-T01.mp4 | 1.23 | no |
| 23 | `59c5fa62-b30e-44b7-acef-97aeebc58fc6` | HOOK-OSO-GOOGLEADSWASTE-T01.mp4 | 0.49 | no |
| 24 | `d2688b1f-11b2-4c13-8db2-1e80f7f7e0f9` | RAW-OSO-CRMLEADMANAGEMEN-T02.mp4 | 2.75 | **yes** |
| 25 | `1154451d-3914-4d86-a2f4-47f0b96ddf64` | RAW-OSO-PRODUCTIONSCALIN-T01.mp4 | 2.57 | **yes** |
| 26 | `85932776-b47a-43ba-bb37-5cc37a6c17c6` | RAW-OSO-UNCLEARFRAGMENT-T01.mp4 | 0.71 | **yes** |

> Rows 24-26 have `drive_url` populated — the original may already be re-fetchable from Drive without manual upload.

---

## SUB_PAR (58 rows — playable but low bitrate, <4 Mbps)

| # | ID | Name | Mbps | Actual MB |
|---|----|----- |------|-----------|
| 1 | `b4bc2fb7-74d7-43ee-8a4a-3aa93702e6d1` | FULL-UNK-DUPLICATELOCATIO-T01.mp4 | 0.3 | 14.42 |
| 2 | `1a422614-018c-43b1-8781-a539d6b9433b` | FULL-UNK-GOOGLEREVIEWSRAN-T01.mp4 | 0.3 | 14.30 |
| 3 | `37ff8231-0188-4b7b-8245-8b6666fa77c1` | BODY-ROOFERS-ROOFCONTRACTORLE-T01.mp4 | 0.4 | 4.52 |
| 4 | `4ce49867-6498-4be5-a34c-6964693868f1` | BODY-ROOFERS-ROOFINGLEADGENER-T01.mp4 | 0.4 | 4.80 |
| 5 | `6cded0df-a626-4237-a925-682c2ba87cef` | BODY-ROOFERS-AIROOFINGLEADS-T01.mp4 | 0.4 | 4.77 |
| 6 | `b292b8e4-73df-47e5-9350-1fc6af66eb57` | BODY-TRADIES-TRADIELEADGENERA-T01.mp4 | 0.4 | 4.34 |
| 7 | `fca26184-e4ee-4c3f-a959-8642f3c4daf2` | BODY-TRADIES-AILEADGENERATION-T01.mp4 | 0.4 | 6.27 |
| 8 | `7c2491bc-1d66-479a-9da3-03cbead3791b` | BODY-TRADIES-30JOBS90DAYSGUAR-T01.mp4 | 0.4 | 4.12 |
| 9 | `033bbc9b-eef6-4bef-813a-d7437e304ea0` | BODY-TRADIES-TRADIECONNECTAI-T01.mp4 | 0.4 | 4.47 |
| 10 | `5f659cd6-fa0c-43d2-b440-5dc34da498d1` | BODY-TRADIES-TRADIELEADGENERA-T01.mp4 | 0.4 | 4.42 |
| 11 | `46006f39-ddd1-4338-8d0f-484cc1ca09fb` | BODY-TRADIES-GUARANTEEDHIGHTI-T01.mp4 | 0.4 | 4.26 |
| 12 | `17131fed-222a-4e96-aebb-9f8ee29bbe1e` | BODY-PLUMBERS-QUALIFIEDLEADSWI-T01.mp4 | 0.4 | 5.49 |
| 13 | `622f73d2-d234-4a2c-8115-619be70e3959` | BODY-PLUMBERS-PLUMBERLEADGENER-T01.mp4 | 0.4 | 5.40 |
| 14 | `ce924aba-0741-462d-9261-ce48303d7515` | BODY-TRADIES-TRADIELEADGENERA-T01.mp4 | 0.4 | 4.20 |
| 15 | `74850de5-09bf-44f4-8475-43054a51937a` | BODY-TRADIES-TRADIELEADGENERA-T01.mp4 | 0.4 | 4.29 |
| 16 | `3df457e1-6a53-4940-9a7d-0e1b05b99d83` | BODY-PLUMBERS-AILEADGENERATION-T01.mp4 | 0.4 | 5.68 |
| 17 | `af378004-f776-4580-b5f5-1bc9dab4998e` | BODY-PLUMBERS-PLUMBERLEADGENER-T01.mp4 | 0.4 | 5.29 |
| 18 | `1fa8ea90-b42e-4e81-9404-4fcfbe1abdad` | BODY-TRADIES-TRADIELEADGENERA-T01.mp4 | 0.4 | 6.40 |
| 19 | `96c87df2-38bc-4d43-ab4f-496f93d8550f` | BODY-PLUMBERS-PLUMBERLEADGENER-T01.mp4 | 0.4 | 5.64 |
| 20 | `6d6f1fd3-2c8c-4789-8716-8367a8526785` | BODY-TRADIES-TRADIELEADGENERA-T01.mp4 | 0.4 | 4.33 |
| 21 | `36426daf-e465-40a0-b744-2118c3b3e2e2` | BODY-TRADIES-QUALIFIEDHOMEOWN-T01.mp4 | 0.4 | 6.32 |
| 22 | `82bfd73b-f8d3-4e70-a233-41cc60958847` | BODY-PLUMBERS-PLUMBERLEADGENER-T01.mp4 | 0.4 | 5.48 |
| 23 | `9ead8bc5-b81b-4f98-8feb-e0e817cd8bc1` | BODY-TRADIES-TRADIELEADGENERA-T01.mp4 | 0.4 | 6.19 |
| 24 | `5b5cd485-19eb-4c01-883a-1860b835313d` | BODY-TRADIES-TRADIELEADGENERA-T01.mp4 | 0.4 | 6.44 |
| 25 | `4cae8ac6-7713-41f2-bc37-923690570b09` | BODY-TRADIES-AIBOOKEDJOBSGUAR-T01.mp4 | 0.4 | 6.24 |
| 26 | `fcf8eb9f-d0d4-4b4c-b2ef-09faf2a14130` | BODY-ELECTRICIANS-GUARANTEED30JOBS-T01.mp4 | 0.5 | 4.80 |
| 27 | `3b41377b-b90f-4e8b-86ba-76626e102570` | BODY-PLUMBERS-PLUMBERLEADGENER-T01.mp4 | 0.4 | 5.31 |
| 28 | `5af950b0-c75e-468a-a0ca-fec4ff753627` | BODY-TRADIES-30JOBS90DAYSGUAR-T01.mp4 | 0.4 | 6.10 |
| 29 | `078be60b-8ab2-4582-add6-8eb497c88451` | BODY-PLUMBERS-PLUMBERLEADGENER-T01.mp4 | 0.4 | 4.04 |
| 30 | `acacecaa-dc0a-46bb-ba10-e0ced4435d57` | JOINED-PROJECT2-GUARANTEEDTOP3GO-T01.mp4 | 0.5 | 4.98 |
| 31 | `4cbac5b3-2d6c-4ccf-baab-c7961d6b674f` | JOINED-PROJECT2-AILEADGENERATION-T01.mp4 | 0.5 | 4.27 |
| 32 | `f4c8103a-90e2-4a88-8c11-71ce1d4c2569` | JOINED-PROJECT2-RESTORATIONLEADG-T01.mp4 | 0.5 | 4.47 |
| 33 | `2da7bcc3-8e54-44fb-aa20-1c1cb5ad945a` | BODY-TRADIES-TRADIELEADGENERA-T01.mp4 | 0.4 | 6.30 |
| 34 | `9df1f440-b0c0-47fb-9392-38cd4d96312c` | BODY-ELECTRICIANS-GUARANTEEDHIGHTI-T01.mp4 | 0.5 | 4.72 |
| 35 | `693e6bb9-21dd-454f-b9dd-99a5f0c45e89` | BODY-ELECTRICIANS-AILEADGENERATION-T01.mp4 | 0.5 | 5.13 |
| 36 | `51bd62d6-db3d-4330-8414-6b8ac305c7e9` | JOINED-PROJECT2-GUARANTEEDTOP3GO-T01.mp4 | 0.5 | 5.05 |
| 37 | `f1f541d0-1ff6-4646-9cba-d67c87c817af` | BODY-ELECTRICIANS-AILEADGENERATION-T01.mp4 | 0.5 | 5.03 |
| 38 | `18c915b9-36d1-49b6-bfbd-d47e538af426` | BODY-PLUMBERS-PLUMBERLEADSAISO-T01.mp4 | 0.4 | 4.02 |
| 39 | `365885ed-f178-4e00-b807-0f9a3cd69c24` | JOINED-PROJECT2-TOPTHREEGOOGLERA-T01.mp4 | 0.5 | 4.99 |
| 40 | `46e3131c-adff-4765-9411-f4ea57492867` | BODY-ELECTRICIANS-AILEADGENERATION-T01.mp4 | 0.5 | 4.89 |
| 41 | `b376d4e9-3b0e-4977-899c-28dcd2729e55` | BODY-ELECTRICIANS-QUALIFIEDLEADSWI-T01.mp4 | 0.5 | 4.84 |
| 42 | `69cc9d68-8437-4070-8958-f54c33839215` | BODY-ELECTRICIANS-AILEADGENERATION-T01.mp4 | 0.5 | 4.77 |
| 43 | `a77ce9f9-3722-4c1f-9b11-1c4bd8306160` | BODY-PLUMBERS-PLUMBERLEADGENER-T01.mp4 | 0.4 | 3.77 |
| 44 | `0f0d343b-a2a3-4b92-8410-37f2c93697b7` | BODY-ELECTRICIANS-AILEADGENERATION-T01.mp4 | 0.5 | 4.87 |
| 45 | `3856c565-e172-4e91-9e20-fa53d9046428` | JOINED-PROJECT2-AILEADGENERATION-T01.mp4 | 0.5 | 4.13 |
| 46 | `3b316eec-d86f-4bbe-8958-e49f1e2b6087` | BODY-PLUMBERS-30JOBSGUARANTEED-T01.mp4 | 0.4 | 3.66 |
| 47 | `689ee042-4dce-4fff-919e-42eb06543d2c` | BODY-PLUMBERS-AIPLUMBERLEADGEN-T01.mp4 | 0.4 | 3.86 |
| 48 | `6eb4836b-a052-4bfa-886d-f64638b213d5` | BODY-PLUMBERS-AILEADSFORPLUMBE-T01.mp4 | 0.4 | 5.37 |
| 49 | `7bfd44c6-cf65-49b5-aeb6-f6870ef8559f` | BODY-PLUMBERS-PLUMBERLEADSGUAR-T01.mp4 | 0.4 | 3.74 |
| 50 | `8bbb38d3-13cc-4511-86e2-1741f0a463ed` | BODY-PLUMBERS-PLUMBERLEADGENER-T01.mp4 | 0.4 | 3.68 |
| 51 | `c219df84-bc36-4102-8f4a-5146b7ca8f94` | BODY-PLUMBERS-PLUMBERCONNECTAI-T01.mp4 | 0.4 | 3.85 |
| 52 | `cfc7f900-cc2b-43fd-8e9b-333c5258f82b` | FULL-UNK-REALLEADSNOTFAKE-T01.mp4 | 0.2 | 3.85 |
| 53 | `f8b78293-79f6-494e-b6aa-74ec9b54ec1c` | FULL-UNK-LOCALSERVICEMARK-T01.mp4 | 0.3 | 3.34 |
| 54 | `6c3fe658-f641-4096-ae5b-52de78b55e6a` | FULL-UNK-STOPADVERTISINGR-T01.mp4 | 0.3 | 3.22 |
| 55 | `46fa9c46-78eb-4d85-b774-60172860ddc0` | FULL-JARED-STOPPAIDADSRESTO-T01.mp4 | 0.4 | 4.22 |
| 56 | `bfa99de3-b9a4-414c-b2c5-a2c1e0821ab9` | RAW-OSO-PLUMBINGLEADGENE-T01.mp4 | — | 5.56 (drive_url avail) |
| 57 | `d8c23965-a546-48b8-83a8-ab813d923106` | RAW-OSO-GOOGLERANKINGLEA-T01.mp4 | — | 9.46 |
| 58 | `9ca6044b-56ca-473b-911e-bac9ddbb2218` | RAW-OSO-WATERDAMAGELEADS-T01.mp4 | — | 6.32 (drive_url avail) |

> Note: `8479d20c-a403-4ba8-85d2-57f098d5735c` (RAW-OSO-GOOGLERESTORATIO-T01) showed 45.80 MB / SUB_PAR in the audit but has `drive_url` — verify before treating as needing re-upload.

---

## Recommended next steps

1. **Confirm current state**: re-run `node scripts/audit-preview-file-sizes.mjs` (requires `SUPABASE_SERVICE_ROLE_KEY` in env) so you're not chasing rows that have already been replaced.
2. **Pull live URLs**: run the SQL query at the top of this file in Supabase SQL editor. The actual `preview_url` is the link to share — append `?download=<filename>` to force a real binary download (per the Video Quality Contract in CLAUDE.md).
3. **Replace from local source**: `node scripts/replace-from-local-files.mjs` pointed at your local copies (TUS resumable upload).
4. **Drive-side priority**: 4 rows (`d2688b1f…`, `1154451d…`, `85932776…`, `bfa99de3…`, `9ca6044b…`) have `drive_url` populated — the original may be re-fetchable from Drive without re-uploading from local.
