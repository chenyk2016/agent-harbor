-- Keep the user request and the confirmed gateway route distinct. Old messages stay unknown.
ALTER TABLE messages ADD COLUMN "requestedModelId" text;
ALTER TABLE messages ADD COLUMN "modelSnapshot" jsonb;
ALTER TABLE messages ADD COLUMN "activatedModelSnapshot" jsonb;
