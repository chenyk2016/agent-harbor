CREATE TABLE observation_report_snapshots (
 id text PRIMARY KEY, app_id text NOT NULL, environment text NOT NULL,
 message_id text NOT NULL, days integer NOT NULL, from_at bigint NOT NULL,
 as_of bigint NOT NULL, expires_at bigint NOT NULL, data jsonb NOT NULL,
 UNIQUE(message_id,days)
);
CREATE INDEX observation_report_snapshots_app ON observation_report_snapshots(app_id,environment);
CREATE INDEX observation_report_snapshots_expiry ON observation_report_snapshots(expires_at);
