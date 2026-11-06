ALTER TABLE sessions ADD COLUMN "analysisAppId" text;
ALTER TABLE sessions ADD COLUMN "analysisEnvironment" text;
ALTER TABLE sessions ADD CONSTRAINT sessions_analysis_scope CHECK (
  ("analysisAppId" IS NULL AND "analysisEnvironment" IS NULL) OR
  ("analysisAppId" IS NOT NULL AND "analysisEnvironment" IS NOT NULL AND "analysisEnvironment" IN ('preview', 'production'))
);
CREATE UNIQUE INDEX sessions_analysis_scope_unique ON sessions ("analysisAppId", "analysisEnvironment")
  WHERE "analysisAppId" IS NOT NULL;
