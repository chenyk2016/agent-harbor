-- Gateway observations never re-charge historical RMB wallet requests.
ALTER TABLE wallet_requests ADD COLUMN "gatewayCallId" text;
CREATE INDEX wallet_requests_gateway_call ON wallet_requests("gatewayCallId");
CREATE TABLE gateway_usage_events (
 id text PRIMARY KEY, "callId" text NOT NULL, "requestId" text,
 "ownerId" text NOT NULL, "sessionId" text NOT NULL,
 model text NOT NULL, status text NOT NULL, "spendUsd" double precision, "pricingKnown" boolean NOT NULL,
 usage jsonb, "costBreakdown" jsonb, "startedAt" bigint NOT NULL, "observedAt" bigint NOT NULL
);
CREATE INDEX gateway_usage_owner_session ON gateway_usage_events("ownerId", "sessionId", "startedAt");
CREATE TABLE gateway_sync_state (
 id text PRIMARY KEY, "scannedUntil" bigint NOT NULL, "lastSuccessAt" bigint NOT NULL
);
