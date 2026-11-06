-- Content belongs to a message and must be removed with it.
ALTER TABLE tracing_outbox
  ADD COLUMN "contentMessageId" text REFERENCES messages(id) ON DELETE CASCADE,
  ADD COLUMN "contentExpiresAt" bigint;
CREATE INDEX tracing_outbox_content_message ON tracing_outbox("contentMessageId") WHERE "contentMessageId" IS NOT NULL;
