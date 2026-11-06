CREATE TABLE app_auth_scopes (
  id uuid PRIMARY KEY,
  app_id text NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  environment text NOT NULL CHECK (environment IN ('preview','production')),
  collection_name text NOT NULL UNIQUE,
  collection_id text UNIQUE,
  origin text NOT NULL UNIQUE,
  enabled boolean NOT NULL DEFAULT false,
  UNIQUE (app_id, environment)
);

CREATE TABLE app_auth_users (
  id uuid PRIMARY KEY,
  scope_id uuid NOT NULL REFERENCES app_auth_scopes(id) ON DELETE CASCADE,
  record_id text NOT NULL,
  disabled_at timestamptz,
  UNIQUE (scope_id, record_id)
);

CREATE TABLE app_auth_sessions (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES app_auth_users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);
CREATE INDEX app_auth_sessions_user ON app_auth_sessions(user_id);
CREATE INDEX app_auth_sessions_expiry ON app_auth_sessions(expires_at);

CREATE TABLE app_auth_flows (
  flow_hash text PRIMARY KEY,
  scope_id uuid NOT NULL REFERENCES app_auth_scopes(id) ON DELETE CASCADE,
  app_browser_hash text NOT NULL,
  auth_browser_hash text,
  return_path text NOT NULL,
  state_hash text UNIQUE,
  code_verifier text,
  handoff_hash text UNIQUE,
  user_id uuid REFERENCES app_auth_users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);
CREATE INDEX app_auth_flows_expiry ON app_auth_flows(expires_at);
