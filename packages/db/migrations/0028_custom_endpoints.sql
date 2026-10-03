CREATE TABLE custom_endpoints (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  api_key TEXT NOT NULL,
  api_format TEXT NOT NULL,
  auth_header TEXT NOT NULL,
  models_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX custom_endpoints_user_id_idx ON custom_endpoints(user_id);
