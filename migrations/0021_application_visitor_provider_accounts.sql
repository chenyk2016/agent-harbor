-- Preserve existing collection and membership IDs, and isolate newly created credentials.
ALTER TABLE app_auth_scopes
  ADD COLUMN password_collection_id text UNIQUE,
  ADD COLUMN google_collection_id text UNIQUE;

ALTER TABLE app_auth_users
  ADD COLUMN collection_id text,
  ADD COLUMN google_alias_record_id text;
UPDATE app_auth_users u SET collection_id=s.collection_id
  FROM app_auth_scopes s WHERE u.scope_id=s.id;
ALTER TABLE app_auth_users
  ALTER COLUMN collection_id SET NOT NULL,
  DROP CONSTRAINT app_auth_users_scope_id_record_id_key,
  ADD UNIQUE (scope_id, collection_id, record_id),
  ADD UNIQUE (scope_id, google_alias_record_id);
