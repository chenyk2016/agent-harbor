ALTER TABLE app_deployments
  ADD COLUMN "runtimeBackend" text NOT NULL DEFAULT 'docker';
