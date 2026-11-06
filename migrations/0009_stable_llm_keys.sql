-- 保留旧Key的到期事实；由运行协调在LiteLLM读回确认后更新为NULL。
ALTER TABLE llm_bindings ALTER COLUMN "expiresAt" DROP NOT NULL;
