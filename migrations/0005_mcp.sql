CREATE TABLE "mcp_connections" (
 "id" text PRIMARY KEY, "ownerId" text NOT NULL REFERENCES "users"("id"),
 "definition" jsonb NOT NULL, "sealed" text NOT NULL, "hasCredentials" integer NOT NULL DEFAULT 0, "revision" integer NOT NULL DEFAULT 1,
 "enabled" integer NOT NULL DEFAULT 1, "deleted" integer NOT NULL DEFAULT 0,
 "createdAt" bigint NOT NULL, "updatedAt" bigint NOT NULL
);
CREATE TABLE "mcp_selections" (
 "sessionId" text PRIMARY KEY REFERENCES "sessions"("id"), "ownerId" text NOT NULL REFERENCES "users"("id")
);
CREATE TABLE "mcp_bindings" (
 "id" text PRIMARY KEY, "sessionId" text NOT NULL REFERENCES "sessions"("id"),
 "ownerId" text NOT NULL REFERENCES "users"("id"), "connectionId" text NOT NULL REFERENCES "mcp_connections"("id"),
 "revision" integer NOT NULL, "definition" jsonb NOT NULL,
 CONSTRAINT "mcp_bindings_session_connection_unique" UNIQUE("sessionId","connectionId")
);
CREATE INDEX "mcp_connections_owner" ON "mcp_connections" ("ownerId");
CREATE INDEX "mcp_bindings_session" ON "mcp_bindings" ("sessionId");
CREATE TABLE "mcp_calls" (
 "id" text PRIMARY KEY, "ownerId" text NOT NULL REFERENCES "users"("id"), "sessionId" text NOT NULL REFERENCES "sessions"("id"),
 "bindingId" text NOT NULL, "tool" text NOT NULL, "status" text NOT NULL, "startedAt" bigint NOT NULL, "finishedAt" bigint
);
CREATE INDEX "mcp_calls_session" ON "mcp_calls" ("sessionId");
