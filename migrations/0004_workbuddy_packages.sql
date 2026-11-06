-- 包内技能保留原名，按专家修订隔离；不会占用用户个人同名技能。
ALTER TABLE skills ADD COLUMN "packageScope" text;
DROP INDEX skills_owner_slug_unique;
CREATE UNIQUE INDEX skills_owner_slug_unique ON skills ("ownerId", slug, coalesce("packageScope", '')) WHERE "ownerId" IS NOT NULL;

-- 用户的MCP连接凭据与可分享的专家包分离，内容在服务端加密。
CREATE TABLE expert_connections (
  id text PRIMARY KEY,
  "userId" text NOT NULL REFERENCES users(id),
  "definitionHash" text NOT NULL,
  name text NOT NULL,
  sealed text NOT NULL,
  "updatedAt" bigint NOT NULL,
  UNIQUE ("userId", "definitionHash", name)
);
