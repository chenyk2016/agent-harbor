-- 保留版本和价格的历史关联；删除中的部署在网关确认后退出管理目录。
ALTER TABLE llm_providers ADD COLUMN "deletedAt" bigint;
ALTER TABLE llm_deployments ADD COLUMN "deletionState" text
  CHECK ("deletionState" IN ('deleting', 'deleted'));
