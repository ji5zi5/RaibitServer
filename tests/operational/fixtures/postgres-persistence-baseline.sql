INSERT INTO "Organization" ("id", "name", "slug", "createdAt", "updatedAt")
VALUES ('org_preflight', 'Preflight', 'preflight', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

INSERT INTO "Project" ("id", "organizationId", "name", "slug", "createdAt", "updatedAt")
VALUES
  ('project_existing', 'org_preflight', 'Existing', 'existing', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('project_other', 'org_preflight', 'Other', 'other', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

INSERT INTO "Service" ("id", "projectId", "name", "slug", "type", "sourceType", "createdAt", "updatedAt")
VALUES ('service_existing', 'project_existing', 'Existing API', 'existing-api', 'web', 'image', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

INSERT INTO "Resource" ("id", "projectId", "name", "slug", "type", "engine", "provider", "plan", "region", "createdAt", "updatedAt")
VALUES
  ('resource_existing', 'project_existing', 'Existing DB', 'existing-db', 'database', 'postgres', 'local', 'starter', 'local', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('resource_restore_target', 'project_existing', 'Restore target', 'restore-target', 'database', 'postgres', 'local', 'starter', 'local', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

INSERT INTO "ResourceBackup" (
  "id", "resourceId", "status", "path", "createdAt", "expiresAt"
) VALUES (
  'backup_legacy_manual', 'resource_existing', 'CREATED', 'legacy/path', CURRENT_TIMESTAMP, TIMESTAMP '2040-01-02 03:04:05'
);

INSERT INTO "ResourceBackup" (
  "id", "resourceId", "status", "createdAt", "formatVersion", "organizationId", "projectId", "engine", "provider",
  "sourceGeneration", "sourceProvenance", "sourceSpec", "requestedByUserId", "requestIdempotencyKey", "requestFingerprint",
  "artifactKey", "artifactChecksum", "artifactSize", "encryptionKeyVersion", "winningAttempt", "readyAt", "expiresAt", "updatedAt"
) VALUES (
  'backup_v1_manual', 'resource_existing', 'READY', CURRENT_TIMESTAMP, 1, 'org_preflight', 'project_existing', 'postgres', 'local',
  'resource-incarnation/v1:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  '{"source":"baseline"}'::jsonb, '{"engine":"postgres"}'::jsonb, 'user_preflight', 'manual-replay', 'manual-fingerprint',
  'manual/artifact.v1', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 128, 'key-v1', 1,
  TIMESTAMP '2030-01-01 00:00:00', TIMESTAMP '2030-01-31 00:00:00', CURRENT_TIMESTAMP
);
