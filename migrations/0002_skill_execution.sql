CREATE TABLE "skill_build_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"buildId" text NOT NULL,
	"clientRequestId" text NOT NULL,
	"requestHash" text NOT NULL,
	"state" text NOT NULL,
	"createdAt" bigint NOT NULL,
	CONSTRAINT "skill_build_request_unique" UNIQUE("userId","clientRequestId")
);
--> statement-breakpoint
CREATE TABLE "skill_builds" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"versionId" text NOT NULL,
	"buildKey" text NOT NULL,
	"imageId" text NOT NULL,
	"state" text NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"containerName" text,
	"artifactPath" text,
	"artifactHash" text,
	"error" text,
	"createdAt" bigint NOT NULL,
	"updatedAt" bigint NOT NULL,
	CONSTRAINT "skill_build_key_unique" UNIQUE("userId","buildKey")
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "capabilitySnapshot" jsonb;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "creationRequestId" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "creationRequestHash" text;--> statement-breakpoint
ALTER TABLE "skill_build_requests" ADD CONSTRAINT "skill_build_requests_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_build_requests" ADD CONSTRAINT "skill_build_requests_buildId_skill_builds_id_fk" FOREIGN KEY ("buildId") REFERENCES "skill_builds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_builds" ADD CONSTRAINT "skill_builds_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_builds" ADD CONSTRAINT "skill_builds_versionId_skill_versions_id_fk" FOREIGN KEY ("versionId") REFERENCES "skill_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_creation_request_unique" UNIQUE("ownerId","creationRequestId");
CREATE UNIQUE INDEX "skills_creation_request_unique" ON "skills" ("ownerId", "creationRequestId");
ALTER TABLE "skills" ADD CONSTRAINT "skills_source_owner_check" CHECK (("source" = 'private' AND "ownerId" IS NOT NULL) OR ("source" = 'builtin' AND "ownerId" IS NULL));
