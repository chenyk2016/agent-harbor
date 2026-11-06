CREATE TABLE experts (
  id text PRIMARY KEY, "ownerId" text REFERENCES users(id), source text NOT NULL, status text NOT NULL DEFAULT 'active',
  name text NOT NULL, description text NOT NULL, "currentVersionId" text NOT NULL,
  "creationRequestId" text, "creationRequestHash" text, "createdAt" bigint NOT NULL, "updatedAt" bigint NOT NULL,
  CONSTRAINT experts_creation_unique UNIQUE ("ownerId", "creationRequestId"),
  CONSTRAINT experts_owner_check CHECK ((source='private' AND "ownerId" IS NOT NULL) OR (source='builtin' AND "ownerId" IS NULL))
);
CREATE TABLE expert_versions (
  id text PRIMARY KEY, "expertId" text NOT NULL REFERENCES experts(id), "versionNumber" integer NOT NULL,
  definition jsonb NOT NULL, instructions text NOT NULL, "contentHash" text NOT NULL,
  "clientRequestId" text NOT NULL, "requestHash" text NOT NULL, "createdAt" bigint NOT NULL,
  CONSTRAINT expert_versions_number_unique UNIQUE ("expertId", "versionNumber"),
  CONSTRAINT expert_versions_request_unique UNIQUE ("expertId", "clientRequestId")
);
CREATE TABLE expert_installs (
  id text PRIMARY KEY, "userId" text NOT NULL REFERENCES users(id), "versionId" text NOT NULL REFERENCES expert_versions(id),
  "imageId" text NOT NULL, status text NOT NULL DEFAULT 'active', "createdAt" bigint NOT NULL
);
CREATE UNIQUE INDEX expert_installs_live_unique ON expert_installs ("userId", "versionId", "imageId") WHERE status <> 'cancelled';
CREATE TABLE expert_install_skills (
  id text PRIMARY KEY, "installId" text NOT NULL REFERENCES expert_installs(id), "versionId" text NOT NULL REFERENCES skill_versions(id),
  "requestId" text NOT NULL REFERENCES skill_build_requests(id),
  CONSTRAINT expert_install_skill_unique UNIQUE ("installId", "versionId")
);
ALTER TABLE sessions ADD COLUMN "expertSnapshot" jsonb;
