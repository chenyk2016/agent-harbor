-- 独立观测库迁移；通过显式observability:migrate执行，服务启动不执行DDL。
CREATE TABLE observation_bindings (
 deployment_id text PRIMARY KEY, app_id text NOT NULL, environment text NOT NULL,
 revision_id text NOT NULL, definition_hash text NOT NULL, definition jsonb NOT NULL,
 token_hash text NOT NULL, enabled boolean NOT NULL DEFAULT true, created_at bigint NOT NULL
);
CREATE TABLE observation_events (
 id bigserial PRIMARY KEY, app_id text NOT NULL, environment text NOT NULL,
 deployment_id text NOT NULL, revision_id text NOT NULL, client_revision_id text,
 definition_hash text NOT NULL, source text NOT NULL, event_id text NOT NULL,
 event_name text NOT NULL, event_version integer NOT NULL, occurred_at bigint NOT NULL,
 received_at bigint NOT NULL, anonymous_id text, session_id text, request_id text,
 properties jsonb NOT NULL, payload_hash text NOT NULL,
 UNIQUE(app_id,environment,source,event_id)
);
CREATE INDEX observation_events_lookup ON observation_events(app_id,environment,occurred_at);
CREATE INDEX observation_events_received ON observation_events(received_at);
CREATE TABLE observation_state (
 app_id text NOT NULL, environment text NOT NULL, key text NOT NULL, value jsonb NOT NULL,
 updated_at bigint NOT NULL, PRIMARY KEY(app_id,environment,key)
);
CREATE TABLE observation_deletions (
 app_id text NOT NULL, environment text NOT NULL, before_at bigint NOT NULL, created_at bigint NOT NULL,
 PRIMARY KEY(app_id,environment)
);

CREATE TABLE observation_dedup (app_id text NOT NULL, environment text NOT NULL, source text NOT NULL, event_id text NOT NULL, payload_hash text NOT NULL, received_at bigint NOT NULL, PRIMARY KEY(app_id,environment,source,event_id));
CREATE INDEX observation_dedup_received ON observation_dedup(received_at);
