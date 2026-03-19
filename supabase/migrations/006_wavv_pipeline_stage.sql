-- Add pipeline stage tracking to wavv_calls
-- pipeline_stage_at_call: the GHL pipeline stage when the call was made
-- pipeline_name_at_call: the pipeline name at time of call
-- current_pipeline_stage: updated on each sync to reflect current stage

ALTER TABLE wavv_calls ADD COLUMN IF NOT EXISTS pipeline_stage_at_call TEXT DEFAULT NULL;
ALTER TABLE wavv_calls ADD COLUMN IF NOT EXISTS pipeline_name_at_call TEXT DEFAULT NULL;
ALTER TABLE wavv_calls ADD COLUMN IF NOT EXISTS current_pipeline_stage TEXT DEFAULT NULL;
