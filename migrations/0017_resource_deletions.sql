-- Cleanup checkpoints are not a recycle bin: content remains inaccessible and cannot be restored.
CREATE TABLE resource_deletions (
 id text PRIMARY KEY, "ownerId" text NOT NULL, kind text NOT NULL CHECK(kind IN ('session','application')),
 "resourceId" text NOT NULL, "sessionId" text,
 state text NOT NULL CHECK(state IN ('running','failed','completed')), phase text NOT NULL,
 error text, "createdAt" bigint NOT NULL, "updatedAt" bigint NOT NULL,
 UNIQUE(kind,"resourceId")
);
CREATE INDEX resource_deletions_owner ON resource_deletions("ownerId","createdAt");
