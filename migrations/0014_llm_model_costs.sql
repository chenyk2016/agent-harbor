-- 供应商成本单价：按供应商 + 上游模型版本化，美元/Token；与人民币售价分离。
CREATE TABLE llm_model_costs (
  id text PRIMARY KEY,
  "providerId" text NOT NULL REFERENCES llm_providers(id),
  "upstreamModel" text NOT NULL,
  "inputUsdPerToken" double precision NOT NULL,
  "outputUsdPerToken" double precision NOT NULL,
  "cacheReadUsdPerToken" double precision NOT NULL,
  "cacheWriteUsdPerToken" double precision NOT NULL,
  "timeoutSeconds" integer NOT NULL,
  "effectiveFrom" bigint NOT NULL,
  "createdBy" text NOT NULL,
  "createdAt" bigint NOT NULL
);
CREATE INDEX llm_model_costs_lookup
  ON llm_model_costs("providerId", "upstreamModel", "effectiveFrom" DESC);
