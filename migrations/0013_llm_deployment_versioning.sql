-- 命名部署 → 不可变模型版本；密钥与售价独立版本化。
-- 一次性回填并删除旧结构，不保留旧接口兼容。

CREATE TABLE llm_provider_secrets (
  id text PRIMARY KEY,
  "providerId" text NOT NULL REFERENCES llm_providers(id),
  version integer NOT NULL,
  secret text NOT NULL,
  "createdAt" bigint NOT NULL,
  "retiredAt" bigint,
  UNIQUE ("providerId", version)
);

INSERT INTO llm_provider_secrets (id, "providerId", version, secret, "createdAt")
SELECT 'secret-' || id, id, 1, secret, "createdAt" FROM llm_providers;

CREATE TABLE llm_deployments (
  id text PRIMARY KEY,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  "currentVersionId" text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  "allowedUsers" jsonb NOT NULL DEFAULT '[]',
  "archivedAt" bigint,
  "createdAt" bigint NOT NULL,
  "updatedAt" bigint NOT NULL
);

CREATE TABLE llm_model_versions (
  id text PRIMARY KEY,
  "deploymentId" text NOT NULL,
  "providerId" text NOT NULL,
  "upstreamModel" text NOT NULL,
  "routeName" text NOT NULL UNIQUE,
  params jsonb NOT NULL DEFAULT '{}',
  tools boolean NOT NULL,
  streaming boolean NOT NULL,
  capabilities jsonb NOT NULL DEFAULT '{}',
  digest text NOT NULL,
  state text NOT NULL,
  "lastSyncedAt" bigint,
  "createdBy" text NOT NULL,
  "createdAt" bigint NOT NULL
);

CREATE TABLE llm_deployment_prices (
  id text PRIMARY KEY,
  "deploymentId" text NOT NULL,
  input bigint NOT NULL,
  output bigint NOT NULL,
  "cacheRead" bigint NOT NULL,
  "cacheWrite" bigint NOT NULL,
  "effectiveFrom" bigint NOT NULL,
  "createdBy" text NOT NULL,
  "createdAt" bigint NOT NULL
);

CREATE TABLE llm_config_audit (
  id text PRIMARY KEY,
  actor text NOT NULL,
  action text NOT NULL,
  target text NOT NULL,
  before jsonb,
  after jsonb,
  reason text,
  "createdAt" bigint NOT NULL
);

INSERT INTO llm_deployments (id, name, description, "currentVersionId", enabled, "allowedUsers", "createdAt", "updatedAt")
SELECT id, name, description, id, enabled, "allowedUsers", "createdAt", "createdAt" FROM llm_models;

INSERT INTO llm_model_versions (id, "deploymentId", "providerId", "upstreamModel", "routeName", params, tools, streaming, capabilities, digest, state, "lastSyncedAt", "createdBy", "createdAt")
SELECT id, id, "providerId", "upstreamModel", alias, '{}'::jsonb, tools, streaming,
  jsonb_build_object('tools', tools, 'streaming', streaming),
  md5("providerId" || '|' || "upstreamModel" || '|' || alias || '|' || tools::text || '|' || streaming::text),
  state, "createdAt", 'migration', "createdAt"
FROM llm_models;

INSERT INTO llm_deployment_prices (id, "deploymentId", input, output, "cacheRead", "cacheWrite", "effectiveFrom", "createdBy", "createdAt")
SELECT 'price-' || id, id,
  (price->>'input')::bigint, (price->>'output')::bigint,
  (price->>'cacheRead')::bigint, (price->>'cacheWrite')::bigint,
  "createdAt", 'migration', "createdAt"
FROM llm_models WHERE price IS NOT NULL;

ALTER TABLE llm_model_versions
  ADD CONSTRAINT llm_model_versions_provider_fk FOREIGN KEY ("providerId") REFERENCES llm_providers(id),
  ADD CONSTRAINT llm_model_versions_deployment_fk FOREIGN KEY ("deploymentId") REFERENCES llm_deployments(id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE llm_deployments
  ADD CONSTRAINT llm_deployments_current_version_fk FOREIGN KEY ("currentVersionId") REFERENCES llm_model_versions(id);
ALTER TABLE llm_deployment_prices
  ADD CONSTRAINT llm_deployment_prices_deployment_fk FOREIGN KEY ("deploymentId") REFERENCES llm_deployments(id);

ALTER TABLE llm_bindings ADD COLUMN "deploymentId" text;
ALTER TABLE llm_bindings ADD COLUMN "versionId" text;
UPDATE llm_bindings SET "deploymentId" = "modelId", "versionId" = "modelId";
ALTER TABLE llm_bindings ALTER COLUMN "deploymentId" SET NOT NULL;
ALTER TABLE llm_bindings ALTER COLUMN "versionId" SET NOT NULL;
ALTER TABLE llm_bindings
  ADD CONSTRAINT llm_bindings_deployment_fk FOREIGN KEY ("deploymentId") REFERENCES llm_deployments(id),
  ADD CONSTRAINT llm_bindings_version_fk FOREIGN KEY ("versionId") REFERENCES llm_model_versions(id);
ALTER TABLE llm_bindings DROP COLUMN "modelId";

ALTER TABLE llm_preferences RENAME TO llm_preferences_old;
CREATE TABLE llm_preferences (
  "ownerId" text PRIMARY KEY,
  "deploymentId" text REFERENCES llm_deployments(id)
);
INSERT INTO llm_preferences ("ownerId", "deploymentId")
SELECT old."ownerId", old."modelId" FROM llm_preferences_old old
JOIN llm_deployments d ON d.id = old."modelId";
DROP TABLE llm_preferences_old;

ALTER TABLE messages RENAME COLUMN "requestedModelId" TO "requestedDeploymentId";

UPDATE sessions s SET "modelSnapshot" = jsonb_build_object(
  'deploymentId', s."modelSnapshot"->>'id',
  'deploymentName', s."modelSnapshot"->>'name',
  'versionId', s."modelSnapshot"->>'id',
  'providerName', s."modelSnapshot"->>'provider',
  'upstreamModel', m."upstreamModel",
  'routeName', s."modelSnapshot"->>'alias')
FROM llm_models m
WHERE s."modelSnapshot" IS NOT NULL AND m.id = s."modelSnapshot"->>'id';

UPDATE messages msg SET "modelSnapshot" = jsonb_build_object(
  'deploymentId', msg."modelSnapshot"->>'id',
  'deploymentName', msg."modelSnapshot"->>'name',
  'versionId', msg."modelSnapshot"->>'id',
  'providerName', msg."modelSnapshot"->>'provider',
  'upstreamModel', m."upstreamModel",
  'routeName', msg."modelSnapshot"->>'alias')
FROM llm_models m
WHERE msg."modelSnapshot" IS NOT NULL AND m.id = msg."modelSnapshot"->>'id';

UPDATE messages msg SET "activatedModelSnapshot" = jsonb_build_object(
  'deploymentId', msg."activatedModelSnapshot"->>'id',
  'deploymentName', msg."activatedModelSnapshot"->>'name',
  'versionId', msg."activatedModelSnapshot"->>'id',
  'providerName', msg."activatedModelSnapshot"->>'provider',
  'upstreamModel', m."upstreamModel",
  'routeName', msg."activatedModelSnapshot"->>'alias')
FROM llm_models m
WHERE msg."activatedModelSnapshot" IS NOT NULL AND m.id = msg."activatedModelSnapshot"->>'id';

ALTER TABLE wallet_requests ADD COLUMN "deploymentId" text;
ALTER TABLE wallet_requests ADD COLUMN "versionId" text;
ALTER TABLE wallet_requests ADD COLUMN "priceVersionId" text;
UPDATE wallet_requests w SET
  "deploymentId" = w."modelId",
  "versionId" = w."modelId",
  "priceVersionId" = COALESCE((
    SELECT p.id FROM llm_deployment_prices p
    WHERE p."deploymentId" = w."modelId"
    ORDER BY p."effectiveFrom" DESC LIMIT 1
  ), 'price-' || w."modelId");
ALTER TABLE wallet_requests ALTER COLUMN "deploymentId" SET NOT NULL;
ALTER TABLE wallet_requests ALTER COLUMN "versionId" SET NOT NULL;
ALTER TABLE wallet_requests ALTER COLUMN "priceVersionId" SET NOT NULL;
ALTER TABLE wallet_requests DROP COLUMN "modelId";

ALTER TABLE gateway_usage_events ADD COLUMN "deploymentId" text;
ALTER TABLE gateway_usage_events ADD COLUMN "versionId" text;
UPDATE gateway_usage_events e SET "deploymentId" = m.id, "versionId" = m.id
FROM llm_models m
WHERE m.alias = e.model OR e.model = m."upstreamModel" OR e.model LIKE '%/' || m."upstreamModel";

ALTER TABLE llm_providers DROP COLUMN secret;
DROP TABLE llm_models;
