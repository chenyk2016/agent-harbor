-- Bind pending session handoffs to the login method that was actually verified.
ALTER TABLE app_auth_flows ADD COLUMN handoff_provider text
  CHECK (handoff_provider IN ('email_password', 'google'));

-- Preserve the last confirmed policy while an environment is offline.
ALTER TABLE app_auth_scopes ADD COLUMN providers jsonb;
