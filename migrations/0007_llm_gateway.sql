CREATE TABLE llm_providers (id text PRIMARY KEY, name text NOT NULL, "apiBase" text NOT NULL, format text NOT NULL, secret text NOT NULL, "createdAt" bigint NOT NULL);
CREATE TABLE llm_models (id text PRIMARY KEY, "providerId" text NOT NULL REFERENCES llm_providers(id), name text NOT NULL, description text NOT NULL, "upstreamModel" text NOT NULL, alias text NOT NULL UNIQUE, enabled boolean NOT NULL DEFAULT true, tools boolean NOT NULL, streaming boolean NOT NULL, "allowedUsers" jsonb NOT NULL, state text NOT NULL, "createdAt" bigint NOT NULL);
CREATE TABLE llm_bindings (id text PRIMARY KEY, "sessionId" text NOT NULL, "ownerId" text NOT NULL, "modelId" text NOT NULL REFERENCES llm_models(id), secret text NOT NULL, state text NOT NULL, "expiresAt" bigint NOT NULL);
CREATE UNIQUE INDEX llm_binding_live ON llm_bindings("sessionId") WHERE state <> 'revoked';
CREATE TABLE llm_preferences ("ownerId" text PRIMARY KEY, "modelId" text REFERENCES llm_models(id));
ALTER TABLE sessions ADD COLUMN "modelSnapshot" jsonb;
