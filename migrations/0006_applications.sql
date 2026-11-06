CREATE TABLE applications (
  id text PRIMARY KEY, "ownerId" text NOT NULL REFERENCES users(id), title text NOT NULL,
  status text NOT NULL DEFAULT 'provisioning', "developmentSessionId" text UNIQUE REFERENCES sessions(id),
  "headRevisionId" text, "nextRevisionNumber" integer NOT NULL DEFAULT 1,
  "stateVersion" integer NOT NULL DEFAULT 0, "lastEventId" bigint NOT NULL DEFAULT 0,
  "createdAt" bigint NOT NULL, "updatedAt" bigint NOT NULL
);
CREATE TABLE app_revisions (
  id text PRIMARY KEY, "appId" text NOT NULL REFERENCES applications(id), number integer NOT NULL,
  "parentId" text, "restoredFromId" text, "sourceMessageId" text, source jsonb NOT NULL, manifest jsonb NOT NULL,
  summary text NOT NULL, "createdAt" bigint NOT NULL,
  CONSTRAINT app_revisions_number_unique UNIQUE ("appId", number),
  CONSTRAINT app_revisions_app_id_unique UNIQUE ("appId", id),
  FOREIGN KEY ("appId", "parentId") REFERENCES app_revisions("appId", id),
  FOREIGN KEY ("appId", "restoredFromId") REFERENCES app_revisions("appId", id)
);
ALTER TABLE applications ADD FOREIGN KEY (id, "headRevisionId") REFERENCES app_revisions("appId",id);
CREATE TABLE app_builds (
  id text PRIMARY KEY, "appId" text NOT NULL REFERENCES applications(id), "revisionId" text NOT NULL,
  target text NOT NULL CHECK (target IN ('preview','production')), status text NOT NULL,
  artifact jsonb, error text, "createdAt" bigint NOT NULL, "updatedAt" bigint NOT NULL,
  UNIQUE ("appId",id), FOREIGN KEY ("appId","revisionId") REFERENCES app_revisions("appId",id)
);
CREATE TABLE app_deployments (
  id text PRIMARY KEY, "appId" text NOT NULL REFERENCES applications(id), "buildId" text NOT NULL,
  environment text NOT NULL CHECK (environment IN ('preview','production')),
  "desiredState" text NOT NULL, "observedState" text NOT NULL, spec jsonb, epoch integer NOT NULL,
  "createdAt" bigint NOT NULL, "updatedAt" bigint NOT NULL,
  UNIQUE ("appId",id), FOREIGN KEY ("appId","buildId") REFERENCES app_builds("appId",id)
);
CREATE TABLE app_endpoints (
  "appId" text NOT NULL REFERENCES applications(id), environment text NOT NULL CHECK (environment IN ('preview','production')),
  generation integer NOT NULL DEFAULT 0, "desiredDeploymentId" text, "appliedDeploymentId" text,
  state text NOT NULL DEFAULT 'offline', "checkedAt" bigint, PRIMARY KEY ("appId", environment),
  FOREIGN KEY ("appId","desiredDeploymentId") REFERENCES app_deployments("appId",id),
  FOREIGN KEY ("appId","appliedDeploymentId") REFERENCES app_deployments("appId",id)
);
CREATE TABLE app_data_environments (
  "appId" text NOT NULL REFERENCES applications(id), environment text NOT NULL CHECK (environment IN ('preview','production')),
  "databaseName" text NOT NULL, role text NOT NULL, schema jsonb NOT NULL, "updatedAt" bigint NOT NULL,
  PRIMARY KEY ("appId", environment)
);
CREATE TABLE app_operations (
  id text PRIMARY KEY, "appId" text NOT NULL REFERENCES applications(id), "ownerId" text NOT NULL REFERENCES users(id),
  kind text NOT NULL, "clientRequestId" text NOT NULL, "requestHash" text NOT NULL, "resourceKey" text NOT NULL,
  state text NOT NULL, phase text NOT NULL, payload jsonb NOT NULL, result jsonb, error text,
  "createdAt" bigint NOT NULL, "updatedAt" bigint NOT NULL,
  CONSTRAINT app_operations_request_unique UNIQUE ("ownerId",kind,"clientRequestId")
);
CREATE UNIQUE INDEX app_operations_one_writer ON app_operations("appId","resourceKey")
  WHERE state IN ('queued','running','cancelling','reconciling');
CREATE TABLE app_events (
  "appId" text NOT NULL REFERENCES applications(id), "eventId" bigint NOT NULL, "operationId" text,
  type text NOT NULL, payload jsonb NOT NULL, "createdAt" bigint NOT NULL, PRIMARY KEY ("appId","eventId")
);
