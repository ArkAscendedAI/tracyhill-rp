CREATE TABLE IF NOT EXISTS wizard_templates (
  user_id TEXT PRIMARY KEY NOT NULL,
  example_state_seed TEXT NOT NULL DEFAULT '',
  example_system_prompt TEXT NOT NULL DEFAULT '',
  seed_update_template TEXT NOT NULL DEFAULT '',
  system_prompt_update_template TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS wizard_runs (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  status TEXT NOT NULL,
  summary TEXT,
  error TEXT,
  details_json TEXT,
  requested_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  approved_at TEXT,
  updated_at TEXT NOT NULL
);
