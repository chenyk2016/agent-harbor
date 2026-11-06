-- Amounts are integer micro-yuan. Existing users start at zero; signup grants apply to new accounts.
CREATE TABLE wallet_settings (
 id text PRIMARY KEY, "signupMicro" bigint NOT NULL, "plusMicro" bigint NOT NULL
);
INSERT INTO wallet_settings VALUES ('platform',10000000,10000000);
CREATE TABLE wallets (
 "userId" text PRIMARY KEY REFERENCES users(id), balance bigint NOT NULL DEFAULT 0 CHECK(balance>=0),
 reserved bigint NOT NULL DEFAULT 0 CHECK(reserved>=0 AND reserved<=balance),
 "plusSince" bigint, "plusUntil" bigint
);
INSERT INTO wallets("userId") SELECT id FROM users;
CREATE TABLE wallet_ledger (
 id text PRIMARY KEY, "userId" text NOT NULL REFERENCES users(id), amount bigint NOT NULL,
 kind text NOT NULL, note text NOT NULL, "balanceAfter" bigint NOT NULL, "createdAt" bigint NOT NULL
);
CREATE INDEX wallet_ledger_user_time ON wallet_ledger("userId","createdAt" DESC);
CREATE TABLE wallet_gifts (
 id text PRIMARY KEY, actor text NOT NULL, amount bigint NOT NULL,
 recipients jsonb NOT NULL, note text NOT NULL, "createdAt" bigint NOT NULL
);
CREATE TABLE wallet_requests (
 id text PRIMARY KEY, "userId" text NOT NULL REFERENCES users(id), "sessionId" text NOT NULL,
 "modelId" text NOT NULL, "modelName" text NOT NULL, price jsonb NOT NULL,
 reserved bigint NOT NULL, actual bigint, charged bigint, waived bigint,
 "inputTokens" bigint, "outputTokens" bigint, "cacheReadTokens" bigint, "cacheWriteTokens" bigint,
 state text NOT NULL, note text NOT NULL DEFAULT '', "createdAt" bigint NOT NULL, "finishedAt" bigint
);
CREATE INDEX wallet_requests_user_time ON wallet_requests("userId","createdAt" DESC);
ALTER TABLE llm_models ADD COLUMN price jsonb;
ALTER TABLE llm_bindings ADD COLUMN "walletTokenHash" text;
CREATE UNIQUE INDEX llm_bindings_wallet_token ON llm_bindings("walletTokenHash");
