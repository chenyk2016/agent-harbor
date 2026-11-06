CREATE TABLE "events" (
	"sessionId" text NOT NULL,
	"eventId" bigint NOT NULL,
	"messageId" text,
	"type" text NOT NULL,
	"payload" text NOT NULL,
	"sourceEventKey" text,
	CONSTRAINT "events_sessionId_eventId_pk" PRIMARY KEY("sessionId","eventId"),
	CONSTRAINT "events_session_source_unique" UNIQUE("sessionId","sourceEventKey")
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" text PRIMARY KEY NOT NULL,
	"sessionId" text NOT NULL,
	"clientMessageId" text NOT NULL,
	"text" text NOT NULL,
	"status" text NOT NULL,
	"cancelRequested" integer DEFAULT 0 NOT NULL,
	"createdEventId" bigint DEFAULT 0 NOT NULL,
	"startedAt" bigint,
	"finishedAt" bigint,
	"result" text,
	CONSTRAINT "messages_session_client_unique" UNIQUE("sessionId","clientMessageId")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"ownerId" text NOT NULL,
	"title" text NOT NULL,
	"createdAt" bigint NOT NULL,
	"updatedAt" bigint NOT NULL,
	"environment" text DEFAULT 'closed' NOT NULL,
	"lastMessageId" text,
	"lastEventId" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "external_identities" (
	"issuer" text NOT NULL,
	"subject" text NOT NULL,
	"userId" text NOT NULL,
	CONSTRAINT "external_identities_issuer_subject_pk" PRIMARY KEY("issuer","subject")
);
--> statement-breakpoint
CREATE TABLE "login_sessions" (
	"hash" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"expiresAt" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"hash" text NOT NULL,
	"userId" text NOT NULL,
	"name" text NOT NULL,
	"createdAt" bigint NOT NULL,
	"expiresAt" bigint,
	"revoked" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "user_keys_hash_unique" UNIQUE("hash")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"disabled" integer DEFAULT 0 NOT NULL,
	"createdAt" bigint NOT NULL,
	"limits" text
);
--> statement-breakpoint
CREATE TABLE "usage_baselines" (
	"sessionId" text PRIMARY KEY NOT NULL,
	"cumulativeUsd" double precision NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_entries" (
	"messageId" text PRIMARY KEY NOT NULL,
	"sessionId" text NOT NULL,
	"userId" text NOT NULL,
	"runnerId" text NOT NULL,
	"cumulativeUsd" double precision NOT NULL,
	"estimatedUsd" double precision,
	"inputTokens" integer,
	"outputTokens" integer,
	"createdAt" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "import_runs" (
	"fingerprint" text PRIMARY KEY NOT NULL,
	"sourcePath" text NOT NULL,
	"sourceVersion" integer NOT NULL,
	"importedAt" bigint NOT NULL,
	"counts" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_sessionId_sessions_id_fk" FOREIGN KEY ("sessionId") REFERENCES "sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sessionId_sessions_id_fk" FOREIGN KEY ("sessionId") REFERENCES "sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_identities" ADD CONSTRAINT "external_identities_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "login_sessions" ADD CONSTRAINT "login_sessions_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_keys" ADD CONSTRAINT "user_keys_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "one_active_message" ON "messages" USING btree ("sessionId") WHERE status in ('accepted','running','finalizing','reconciling');--> statement-breakpoint
CREATE INDEX "messages_session_created_event" ON "messages" USING btree ("sessionId","createdEventId");--> statement-breakpoint
CREATE INDEX "sessions_owner_updated" ON "sessions" USING btree ("ownerId","updatedAt" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "sessions_owner_created" ON "sessions" USING btree ("ownerId","createdAt" DESC NULLS LAST,"id" DESC NULLS LAST);