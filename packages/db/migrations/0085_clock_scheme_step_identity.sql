-- Bind every newly-created scheme clock to the exact step that authored it.
-- Existing clocks are reconciled against their stored impulse before reuse.
ALTER TABLE threat_clocks ADD COLUMN scheme_step_key TEXT;
