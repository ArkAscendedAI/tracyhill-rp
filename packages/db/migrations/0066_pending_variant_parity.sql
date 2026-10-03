-- 0066: variant parity on pending_assistant_messages.
--
-- Disconnect-recovery (a regenerate whose client dropped mid-stream) must land
-- the recovered reply as an INACTIVE sibling of the variant group it was minted
-- into — never yanking the active variant the user may have already switched to.
-- Carry the variant_group_id through the pending insert so the merge can re-attach
-- the recovered row to its group (variant_active=0) at the slot's shared sort_order.
-- NULL for the normal non-regenerate path (image-gen + first-reply pending rows
-- stay singletons, exactly as before).
ALTER TABLE pending_assistant_messages ADD COLUMN variant_group_id TEXT;
