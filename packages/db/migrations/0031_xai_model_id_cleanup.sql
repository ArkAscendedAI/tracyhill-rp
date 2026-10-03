UPDATE sessions
SET model_id = 'grok-4.20-beta-0309-reasoning'
WHERE model_id = 'grok-4.20-reasoning';

UPDATE messages
SET model_id = 'grok-4.20-beta-0309-reasoning'
WHERE model_id = 'grok-4.20-reasoning';

UPDATE pending_assistant_messages
SET model_id = 'grok-4.20-beta-0309-reasoning'
WHERE model_id = 'grok-4.20-reasoning';

UPDATE campaigns
SET pipeline_model_id = 'grok-4.20-beta-0309-reasoning'
WHERE pipeline_model_id = 'grok-4.20-reasoning';

UPDATE wizard_runs
SET model_id = 'grok-4.20-beta-0309-reasoning'
WHERE model_id = 'grok-4.20-reasoning';
