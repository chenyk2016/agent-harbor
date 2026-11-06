-- Telemetry is a recoverable projection, never a billing or authorization authority.
CREATE TABLE tracing_targets (
  destination text PRIMARY KEY, "createdAt" bigint NOT NULL, "instanceId" text NOT NULL,
  "projectId" text, "lastSuccessAt" bigint, "lastError" text,
  dropped bigint NOT NULL DEFAULT 0
);
CREATE TABLE tracing_cursors (
  destination text NOT NULL, "sessionId" text NOT NULL,
  "eventId" bigint NOT NULL, PRIMARY KEY(destination,"sessionId")
);
CREATE TABLE tracing_requests (
  "requestId" text NOT NULL, destination text NOT NULL,
  "traceId" text NOT NULL, "spanId" text NOT NULL,
  "createdAt" bigint NOT NULL, confirmed boolean NOT NULL DEFAULT false,
  PRIMARY KEY(destination,"requestId")
);
CREATE TABLE tracing_outbox (
  destination text NOT NULL, id text NOT NULL, span jsonb NOT NULL,
  "createdAt" bigint NOT NULL, "nextAttemptAt" bigint NOT NULL DEFAULT 0,
  attempts integer NOT NULL DEFAULT 0, "sentAt" bigint,
  "lastError" text, PRIMARY KEY(destination,id)
);
CREATE INDEX tracing_outbox_pending ON tracing_outbox(destination,"nextAttemptAt","createdAt") WHERE "sentAt" IS NULL;
