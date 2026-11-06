-- 管理操作意图先持久化；unknown不是业务回滚或成功证明。
CREATE TABLE admin_audit (
  id text PRIMARY KEY, actor text NOT NULL, action text NOT NULL, target text NOT NULL,
  before jsonb, requested jsonb, result jsonb, outcome text NOT NULL,
  "createdAt" bigint NOT NULL, "finishedAt" bigint
);
CREATE INDEX admin_audit_created ON admin_audit ("createdAt" DESC, id);
CREATE TABLE admin_incidents (
  id text PRIMARY KEY, kind text NOT NULL, target text NOT NULL, title text NOT NULL,
  active boolean NOT NULL, status text NOT NULL DEFAULT 'open', assignee text,
  note text NOT NULL DEFAULT '', "firstSeenAt" bigint NOT NULL, "lastSeenAt" bigint NOT NULL,
  "recoveredAt" bigint, "updatedAt" bigint NOT NULL
);
ALTER TABLE wallet_requests ADD COLUMN "messageId" text;
ALTER TABLE wallet_requests ADD COLUMN "httpStatus" integer;
ALTER TABLE wallet_requests ADD COLUMN "durationMs" bigint;
ALTER TABLE wallet_requests ADD COLUMN "failureCode" text;
CREATE INDEX wallet_requests_admin_created ON wallet_requests ("createdAt" DESC, id);
CREATE INDEX wallet_requests_message ON wallet_requests ("messageId");
CREATE INDEX wallet_ledger_admin_created ON wallet_ledger ("createdAt" DESC, id);
CREATE INDEX events_admin_message ON events ("sessionId", "messageId", "eventId");
