ALTER TABLE app_auth_scopes ADD COLUMN backend text NOT NULL DEFAULT 'pocketbase'
  CHECK (backend IN ('pocketbase','better_auth'));

CREATE FUNCTION ah_create_visitor_realm(realm text) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog AS $body$
BEGIN
  IF realm !~ '^ahv_[a-f0-9]{32}_[eg]$' THEN
    RAISE EXCEPTION 'Invalid visitor realm';
  END IF;
  EXECUTE format('CREATE SCHEMA %I', realm);
  EXECUTE format($ddl$
CREATE TABLE %1$I.ah_auth_user (
  id text PRIMARY KEY,
  name text NOT NULL,
  email text NOT NULL UNIQUE,
  "emailVerified" boolean NOT NULL,
  image text,
  "createdAt" timestamptz NOT NULL,
  "updatedAt" timestamptz NOT NULL
);
CREATE TABLE %1$I.ah_auth_session (
  id text PRIMARY KEY,
  token text NOT NULL UNIQUE,
  "expiresAt" timestamptz NOT NULL,
  "createdAt" timestamptz NOT NULL,
  "updatedAt" timestamptz NOT NULL,
  "ipAddress" text,
  "userAgent" text,
  "userId" text NOT NULL REFERENCES %1$I.ah_auth_user(id) ON DELETE CASCADE
);
CREATE INDEX ah_auth_session_user ON %1$I.ah_auth_session("userId");
CREATE TABLE %1$I.ah_auth_account (
  id text PRIMARY KEY,
  "accountId" text NOT NULL,
  "providerId" text NOT NULL,
  "userId" text NOT NULL REFERENCES %1$I.ah_auth_user(id) ON DELETE CASCADE,
  "accessToken" text,
  "refreshToken" text,
  "idToken" text,
  "accessTokenExpiresAt" timestamptz,
  "refreshTokenExpiresAt" timestamptz,
  scope text,
  password text,
  "createdAt" timestamptz NOT NULL,
  "updatedAt" timestamptz NOT NULL
);
CREATE INDEX ah_auth_account_user ON %1$I.ah_auth_account("userId");
CREATE TABLE %1$I.ah_auth_verification (
  id text PRIMARY KEY,
  identifier text NOT NULL,
  value text NOT NULL,
  "expiresAt" timestamptz NOT NULL,
  "createdAt" timestamptz NOT NULL,
  "updatedAt" timestamptz NOT NULL
);
CREATE INDEX ah_auth_verification_identifier ON %1$I.ah_auth_verification(identifier);  $ddl$, realm);
END
$body$;
