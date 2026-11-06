CREATE TABLE "skill_imports" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"clientRequestId" text NOT NULL,
	"clientRequestHash" text NOT NULL,
	"fileName" text NOT NULL,
	"expectedSize" bigint NOT NULL,
	"expectedSha256" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"stagingPath" text,
	"report" jsonb,
	"targetSkillId" text,
	"resultVersionId" text,
	"createdAt" bigint NOT NULL,
	"updatedAt" bigint NOT NULL,
	CONSTRAINT "skill_imports_user_request_unique" UNIQUE("userId","clientRequestId")
);
--> statement-breakpoint
CREATE TABLE "skill_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"skillId" text NOT NULL,
	"versionNumber" integer NOT NULL,
	"sourceHash" text NOT NULL,
	"manifest" jsonb NOT NULL,
	"fileCount" integer NOT NULL,
	"sizeBytes" bigint NOT NULL,
	"sourcePath" text NOT NULL,
	"publishRequestId" text NOT NULL,
	"publishRequestHash" text NOT NULL,
	"createdAt" bigint NOT NULL,
	CONSTRAINT "skill_versions_number_unique" UNIQUE("skillId","versionNumber"),
	CONSTRAINT "skill_versions_request_unique" UNIQUE("skillId","publishRequestId")
);
--> statement-breakpoint
CREATE TABLE "skills" (
	"id" text PRIMARY KEY NOT NULL,
	"ownerId" text,
	"source" text NOT NULL,
	"slug" text NOT NULL,
	"displayName" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"draftRevision" bigint DEFAULT 0 NOT NULL,
	"draftPath" text,
	"currentVersionId" text,
	"creationRequestId" text,
	"creationRequestHash" text,
	"createdAt" bigint NOT NULL,
	"updatedAt" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_skills" (
	"userId" text NOT NULL,
	"skillId" text NOT NULL,
	"enabled" integer DEFAULT 0 NOT NULL,
	"activeVersionId" text,
	"desiredVersionId" text,
	"desiredEnabled" integer DEFAULT 0 NOT NULL,
	"pendingRequestId" text,
	"revision" bigint DEFAULT 0 NOT NULL,
	"createdAt" bigint NOT NULL,
	"updatedAt" bigint NOT NULL,
	CONSTRAINT "user_skills_userId_skillId_pk" PRIMARY KEY("userId","skillId")
);
--> statement-breakpoint
ALTER TABLE "skill_imports" ADD CONSTRAINT "skill_imports_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_imports" ADD CONSTRAINT "skill_imports_targetSkillId_skills_id_fk" FOREIGN KEY ("targetSkillId") REFERENCES "skills"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_versions" ADD CONSTRAINT "skill_versions_skillId_skills_id_fk" FOREIGN KEY ("skillId") REFERENCES "skills"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_ownerId_users_id_fk" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_skills" ADD CONSTRAINT "user_skills_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_skills" ADD CONSTRAINT "user_skills_skillId_skills_id_fk" FOREIGN KEY ("skillId") REFERENCES "skills"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "skills_owner_slug_unique" ON "skills" USING btree ("ownerId","slug") WHERE "skills"."ownerId" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "skills_builtin_slug_unique" ON "skills" USING btree ("slug") WHERE "skills"."source" = 'builtin';--> statement-breakpoint
CREATE INDEX "skills_owner_updated" ON "skills" USING btree ("ownerId","updatedAt" DESC NULLS LAST);