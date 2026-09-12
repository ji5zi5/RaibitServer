import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import test from 'node:test';

const BASELINE = 'b0e48beadc0e95427aceed7aa3436bb56ae938d1';
const MIGRATION_SHA256 = '3f0aba94669d906664b6b734d47d02d946a0960ba69e5501945bf6a5b17df817';
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);
const evidenceDir = process.env.RAIBITSERVER_OPERATIONAL_EVIDENCE_DIR;
const results = [];
let postgresVersion = 'unavailable';

function record(name, observable) {
  results.push({ name, observable, status: 'passed' });
}

function git(...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

function materializeBaseline(directory) {
  const paths = git('ls-tree', '-r', '--name-only', BASELINE, 'prisma')
    .trim().split('\n').filter((path) => path === 'prisma/schema.prisma' || path.endsWith('/migration.sql'));
  for (const path of paths) {
    const destination = join(directory, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, git('show', `${BASELINE}:${path}`));
  }
}

function migrate(schemaPath, databaseUrl) {
  try {
    execFileSync(process.execPath, [require.resolve('prisma/build/index.js'), 'migrate', 'deploy', '--schema', schemaPath], {
      cwd: root,
      env: { ...process.env, DATABASE_URL: databaseUrl, PRISMA_HIDE_UPDATE_MESSAGE: 'true' },
      encoding: 'utf8',
      timeout: 120_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    if (error instanceof Error) {
      const password = new URL(databaseUrl).password;
      const diagnostic = [error.message, error.stdout, error.stderr]
        .filter((value) => typeof value === 'string' && value.length > 0)
        .join('\n')
        .replaceAll(databaseUrl, 'postgresql://[redacted]')
        .replaceAll(password, '[redacted-password]')
        .replace(/postgres(?:ql)?:\/\/[^@\s]+@/gu, 'postgresql://[redacted]@')
        .slice(-4_000);
      throw new Error(`Prisma migrate deploy failed with sanitized diagnostics:\n${diagnostic}`);
    }
    throw error;
  }
}

async function executeFixture(client, path) {
  const statements = readFileSync(path, 'utf8').split(/;\s*(?:\r?\n|$)/u).map((sql) => sql.trim()).filter(Boolean);
  for (const sql of statements) await client.$executeRawUnsafe(sql);
}

async function protocol2(client, work) {
  return client.$transaction(async (transaction) => {
    await transaction.$executeRawUnsafe("SET LOCAL raibitserver.operational_protocol = '2'");
    return work(transaction);
  }, { timeout: 30_000 });
}

async function expectRejected(client, scenario) {
  await assert.rejects(
    client.$transaction(async (transaction) => {
      if (scenario.protocol === 2) await transaction.$executeRawUnsafe("SET LOCAL raibitserver.operational_protocol = '2'");
      const statements = Array.isArray(scenario.sql) ? scenario.sql : [scenario.sql];
      for (const sql of statements) await transaction.$executeRawUnsafe(sql);
      await transaction.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
    }, { timeout: 30_000 }),
    scenario.error,
  );
  record(scenario.name, `rejected:${scenario.error.source}`);
}

const snapshot = '{"requiredProtocolVersion":2,"enabled":true,"timezone":"Asia/Seoul","origin":"scheduled","retention":{"mode":"success-count","count":7}}';
const generation = 'resource-incarnation/v1:sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';

async function insertScheduled(client, id, readyValues) {
  await protocol2(client, async (transaction) => {
    await transaction.$executeRawUnsafe(`INSERT INTO "BackupPolicyRun" ("id","policyId","organizationId","projectId","environmentId","resourceId","scheduledAtUtc","policyVersion","policySnapshot","updatedAt") VALUES ('run_${id}','policy_main','org_preflight','project_existing','env_prod_project_existing','resource_existing',TIMESTAMP '2031-01-0${id} 18:00:00',1,'${snapshot}'::jsonb,CURRENT_TIMESTAMP)`);
    await transaction.$executeRawUnsafe(`INSERT INTO "ResourceBackup" ("id","resourceId","status","createdAt","formatVersion","organizationId","projectId","engine","provider","sourceGeneration","sourceProvenance","sourceSpec","requestedByUserId","requestIdempotencyKey","requestFingerprint","updatedAt","origin","policyId","policyRunId","policyVersion","scheduledAtUtc","policySnapshot","environmentId"${readyValues ? ',"artifactKey","artifactChecksum","artifactSize","encryptionKeyVersion","winningAttempt","readyAt","expiresAt"' : ''}) VALUES ('scheduled_${id}','resource_existing','${readyValues ? 'READY' : 'QUEUED'}',CURRENT_TIMESTAMP,1,'org_preflight','project_existing','postgres','local','${generation}','{"source":"scheduled"}'::jsonb,'{"engine":"postgres"}'::jsonb,'user_preflight','scheduled-${id}','fingerprint-${id}',CURRENT_TIMESTAMP,'scheduled','policy_main','run_${id}',1,TIMESTAMP '2031-01-0${id} 18:00:00','${snapshot}'::jsonb,'env_prod_project_existing'${readyValues ? `,${readyValues}` : ''})`);
  });
}

test('current operational migration passes the focused real PostgreSQL compatibility gate', { timeout: 180_000 }, async (t) => {
  assert.ok(process.env.RAIBITSERVER_TEST_DATABASE_URL, 'RAIBITSERVER_TEST_DATABASE_URL is required; refusing a skipped green');
  assert.ok(evidenceDir, 'RAIBITSERVER_OPERATIONAL_EVIDENCE_DIR is required');
  const { PrismaClient } = await import('@prisma/client');
  const suffix = randomUUID().replaceAll('-', '');
  const role = `raibit_preflight_${suffix}`;
  const database = `raibit_preflight_${suffix}`;
  const password = randomBytes(24).toString('base64url');
  const adminUrl = new URL(process.env.RAIBITSERVER_TEST_DATABASE_URL);
  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${database}`;
  databaseUrl.username = role;
  databaseUrl.password = password;
  mkdirSync(evidenceDir, { recursive: true });
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'raibit-postgres-preflight-'));
  const admin = new PrismaClient({ datasourceUrl: adminUrl.href });
  let client;
  const failures = [];

  try {
    await admin.$executeRawUnsafe(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}'`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${database}" OWNER "${role}"`);
    const owner = await admin.$queryRawUnsafe(`SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = '${database}'`);
    assert.equal(owner[0]?.owner, role);
    record('ephemeral database ownership', 'generated database owner matched generated login');

    materializeBaseline(fixtureRoot);
    const schemaPath = join(fixtureRoot, 'prisma/schema.prisma');
    const migrationPath = join(root, 'prisma/migrations/202609130001_operational_persistence/migration.sql');
    assert.equal(createHash('sha256').update(readFileSync(migrationPath)).digest('hex'), MIGRATION_SHA256);
    record('Task2 SQL freeze', `current migration SHA-256 matched ${MIGRATION_SHA256}`);
    migrate(schemaPath, databaseUrl.href);
    client = new PrismaClient({ datasourceUrl: databaseUrl.href });
    await executeFixture(client, join(root, 'tests/operational/fixtures/postgres-persistence-baseline.sql'));
    await client.$disconnect();
    client = undefined;
    cpSync(join(root, 'prisma/migrations/202609130001_operational_persistence'), join(fixtureRoot, 'prisma/migrations/202609130001_operational_persistence'), { recursive: true });
    migrate(schemaPath, databaseUrl.href);
    client = new PrismaClient({ datasourceUrl: databaseUrl.href });
    const version = await client.$queryRawUnsafe('SHOW server_version');
    postgresVersion = version[0]?.server_version ?? 'unavailable';
    assert.match(postgresVersion, /^16\./u);
    record('PostgreSQL runtime', `server_version=${postgresVersion}`);
    record('baseline upgrade', `exact ${BASELINE} migration tree plus current operational migration applied`);

    const preserved = await client.$queryRawUnsafe(`SELECT s."id" AS service_id,s."slug" AS service_slug,r."id" AS resource_id,r."slug" AS resource_slug,b."origin" AS legacy_origin,b."expiresAt" AS legacy_expiry,m."origin" AS manual_origin,m."expiresAt" AS manual_expiry FROM "Service" s JOIN "Resource" r ON r."id"='resource_existing' JOIN "ResourceBackup" b ON b."id"='backup_legacy_manual' JOIN "ResourceBackup" m ON m."id"='backup_v1_manual' WHERE s."id"='service_existing'`);
    assert.deepEqual([preserved[0].service_id, preserved[0].service_slug, preserved[0].resource_id, preserved[0].resource_slug], ['service_existing', 'existing-api', 'resource_existing', 'existing-db']);
    assert.deepEqual([preserved[0].legacy_origin, preserved[0].manual_origin], ['manual', 'manual']);
    assert.equal(preserved[0].legacy_expiry.toISOString(), '2040-01-02T03:04:05.000Z');
    assert.equal(preserved[0].manual_expiry.toISOString(), '2030-01-31T00:00:00.000Z');
    record('production preservation', 'existing IDs, physical slugs, and both legacy/manual expiries remained byte-equivalent');

    await client.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe("SET LOCAL raibitserver.operational_protocol = '1'");
      await transaction.$executeRawUnsafe(`INSERT INTO "Project" ("id","organizationId","name","slug","createdAt","updatedAt") VALUES ('project_n1','org_preflight','N-1','n-1',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`);
      await transaction.$executeRawUnsafe(`INSERT INTO "Service" ("id","projectId","name","slug","type","sourceType","createdAt","updatedAt") VALUES ('service_n1','project_n1','N-1 API','n1-api','web','image',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`);
      await transaction.$executeRawUnsafe(`INSERT INTO "Resource" ("id","projectId","name","slug","type","engine","provider","plan","region","createdAt","updatedAt") VALUES ('resource_n1','project_n1','N-1 DB','n1-db','database','postgres','local','starter','local',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`);
      await transaction.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
    });
    const bindings = await client.$queryRawUnsafe(`SELECT e."id",e."kind",s."logicalSlug" AS service_slug,r."logicalSlug" AS resource_slug FROM "Environment" e JOIN "EnvironmentService" s ON s."environmentId"=e."id" JOIN "EnvironmentResource" r ON r."environmentId"=e."id" WHERE e."projectId"='project_n1'`);
    assert.deepEqual(bindings, [{ id: 'env_prod_project_n1', kind: 'prod', service_slug: 'n1-api', resource_slug: 'n1-db' }]);
    await client.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe(`UPDATE "Service" SET "status"='READY' WHERE "id"='service_n1'`);
      await transaction.$executeRawUnsafe(`UPDATE "Resource" SET "status"='READY' WHERE "id"='resource_n1'`);
      await transaction.$executeRawUnsafe(`DELETE FROM "Service" WHERE "id"='service_n1'`);
      await transaction.$executeRawUnsafe(`DELETE FROM "Resource" WHERE "id"='resource_n1'`);
    });
    record('N-1 protocol-1 writes while OFF', 'fresh project/service/resource create, update, and delete committed with exact prod bindings');

    await expectRejected(client, { name: 'cross-project binding', protocol: 2, sql: [
      `INSERT INTO "Service" ("id","projectId","name","slug","type","sourceType","createdAt","updatedAt") VALUES ('service_cross','project_existing','Cross API','cross-api','web','image',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
      `INSERT INTO "EnvironmentService" ("serviceId","environmentId","projectId","logicalSlug","createdAt","updatedAt") VALUES ('service_cross','env_prod_project_other','project_other','cross-api',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
    ], error: /foreign key/i });
    await protocol2(client, async (transaction) => {
      await transaction.$executeRawUnsafe(`INSERT INTO "Environment" ("id","projectId","kind","createdAt","updatedAt") VALUES ('env_dev_project_existing','project_existing','dev',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`);
      await transaction.$executeRawUnsafe(`INSERT INTO "Service" ("id","projectId","name","slug","type","sourceType","createdAt","updatedAt") VALUES ('service_dev','project_existing','Dev API','dev-api','web','image',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`);
      await transaction.$executeRawUnsafe(`INSERT INTO "EnvironmentService" ("serviceId","environmentId","projectId","logicalSlug","createdAt","updatedAt") VALUES ('service_dev','env_dev_project_existing','project_existing','api',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`);
      await transaction.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
    });
    await expectRejected(client, { name: 'protocol-1 dev write', sql: `UPDATE "Service" SET "status"='READY' WHERE "id"='service_dev'`, error: /OPERATIONAL_PROTOCOL_2_REQUIRED/ });
    await expectRejected(client, { name: 'protocol-1 operational job', sql: `INSERT INTO "WorkflowJob" ("id","type","targetType","targetId","payload","createdAt","updatedAt") VALUES ('job_v1','operational.backup','resource','resource_existing','{}',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`, error: /OPERATIONAL_PROTOCOL_2_REQUIRED/ });

    await protocol2(client, async (transaction) => {
      await transaction.$executeRawUnsafe(`INSERT INTO "NotificationDestination" ("id","projectId","kind","sealedWebhookUrl","encryptionKeyVersion","updatedAt") VALUES ('destination_main','project_existing','discord','sealed:test','key-v1',CURRENT_TIMESTAMP)`);
    });
    await expectRejected(client, { name: 'destination row-shape dispatch', protocol: 2, sql: `UPDATE "NotificationDestination" SET "sealedWebhookUrl"='sealed:changed' WHERE "id"='destination_main'`, error: /NOTIFICATION_DESTINATION_VERSION_INVALID/ });
    await expectRejected(client, { name: 'subscription row-shape dispatch', protocol: 2, sql: `INSERT INTO "NotificationSubscription" ("id","projectId","destinationId","environmentId","environmentKind","eventCode","updatedAt") VALUES ('subscription_bad','project_existing','destination_main','env_prod_project_existing','dev','backup.failed',CURRENT_TIMESTAMP)`, error: /NOTIFICATION_ENVIRONMENT_INVALID/ });
    record('generic trigger dispatch', 'native protocol/state trigger calls covered Service, WorkflowJob, destination, subscription, policy/run, and backup row shapes');

    await protocol2(client, async (transaction) => {
      await transaction.$executeRawUnsafe(`INSERT INTO "BackupPolicy" ("id","organizationId","projectId","environmentId","resourceId","createdByUserId","updatedAt") VALUES ('policy_main','org_preflight','project_existing','env_prod_project_existing','resource_existing','user_preflight',CURRENT_TIMESTAMP)`);
    });
    await expectRejected(client, { name: 'scheduled NULL format', protocol: 2, sql: `INSERT INTO "ResourceBackup" ("id","resourceId","status","createdAt","organizationId","projectId","engine","provider","sourceGeneration","sourceProvenance","sourceSpec","requestedByUserId","requestIdempotencyKey","requestFingerprint","updatedAt","origin","policyId","policyRunId","policyVersion","scheduledAtUtc","policySnapshot","environmentId") VALUES ('scheduled_null_format','resource_existing','QUEUED',CURRENT_TIMESTAMP,'org_preflight','project_existing','postgres','local','${generation}','{}','{}','user_preflight','null-format','fingerprint',CURRENT_TIMESTAMP,'scheduled','policy_main','missing_run',1,TIMESTAMP '2031-01-09 18:00:00','${snapshot}'::jsonb,'env_prod_project_existing')`, error: /ResourceBackup_scheduled_policy_check/ });
    await insertScheduled(client, '1', null);
    await protocol2(client, async (transaction) => {
      await transaction.$executeRawUnsafe(`UPDATE "ResourceBackup" SET "status"='RUNNING',"startedAt"=TIMESTAMP '2031-01-01 18:01:00' WHERE "id"='scheduled_1'`);
      await transaction.$executeRawUnsafe(`UPDATE "ResourceBackup" SET "status"='VERIFYING' WHERE "id"='scheduled_1'`);
      await transaction.$executeRawUnsafe(`UPDATE "ResourceBackup" SET "status"='READY',"artifactKey"='scheduled/artifact.v1',"artifactChecksum"='dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',"artifactSize"=256,"encryptionKeyVersion"='key-v1',"winningAttempt"=1,"readyAt"=TIMESTAMP '2031-01-01 18:05:00' WHERE "id"='scheduled_1'`);
    });
    const scheduled = await client.$queryRawUnsafe(`SELECT "formatVersion","expiresAt","sourceProvenance","artifactKey" FROM "ResourceBackup" WHERE "id"='scheduled_1'`);
    assert.equal(scheduled[0].formatVersion, 1);
    assert.equal(scheduled[0].expiresAt, null);
    assert.deepEqual(scheduled[0].sourceProvenance, { source: 'scheduled' });
    assert.equal(scheduled[0].artifactKey, 'scheduled/artifact.v1');
    record('scheduled format-1 lifecycle', 'QUEUED→RUNNING→VERIFYING→READY retained provenance/artifact and no age expiry');

    await insertScheduled(client, '2', `'bad/artifact',NULL,1,'key-v1',1,TIMESTAMP '2031-01-02 18:05:00',NULL`).then(() => assert.fail('NULL READY checksum accepted'), (error) => assert.match(String(error), /ResourceBackup_ready_complete/));
    record('malformed NULL READY artifact', 'native READY completeness constraint rejected NULL checksum');
    await expectRejected(client, { name: 'scheduled provenance guard', protocol: 2, sql: `UPDATE "ResourceBackup" SET "sourceProvenance"='{"changed":true}' WHERE "id"='scheduled_1'`, error: /RECOVERY_PROVENANCE_IMMUTABLE/ });
    await expectRejected(client, { name: 'scheduled artifact guard', protocol: 2, sql: `UPDATE "ResourceBackup" SET "artifactKey"='changed' WHERE "id"='scheduled_1'`, error: /RECOVERY_ARTIFACT_IMMUTABLE/ });
    await protocol2(client, async (transaction) => {
      await transaction.$executeRawUnsafe(`INSERT INTO "ResourceRecoveryPin" ("id","resourceId","backupId","kind") VALUES ('pin_scheduled','resource_existing','scheduled_1','ARTIFACT_SOURCE')`);
      await transaction.$executeRawUnsafe(`INSERT INTO "ResourceRestore" ("id","organizationId","projectId","backupId","sourceResourceId","targetResourceId","engine","provider","sourceGeneration","requestedByUserId","requestIdempotencyKey","requestFingerprint","updatedAt") VALUES ('restore_scheduled','org_preflight','project_existing','scheduled_1','resource_existing','resource_restore_target','postgres','local','${generation}','user_preflight','restore-replay','restore-fingerprint',CURRENT_TIMESTAMP)`);
    });
    await expectRejected(client, { name: 'scheduled deletion guard', protocol: 2, sql: `DELETE FROM "ResourceBackup" WHERE "id"='scheduled_1'`, error: /RECOVERY_CLEANUP_PENDING/ });
    record('scheduled restore and pin eligibility', 'format-1 restore and ARTIFACT_SOURCE pin inserts committed');

    await protocol2(client, async (transaction) => {
      await transaction.$executeRawUnsafe(`INSERT INTO "WorkflowJob" ("id","type","targetType","targetId","payload","operationalProtocolVersion","createdAt","updatedAt") VALUES ('job_v2','operational.backup','resource','resource_existing','{}',2,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`);
    });
    await expectRejected(client, { name: 'scoped stale protocol demotion', protocol: 2, sql: `UPDATE "WorkflowJob" SET "operationalProtocolVersion"=1 WHERE "id"='job_v2'`, error: /OPERATIONAL_PROTOCOL_2_REQUIRED/ });
  } catch (error) {
    failures.push(error);
  } finally {
    const cleanup = [];
    for (const [action, attempt] of [
      ['evidence-write', () => writeFileSync(join(evidenceDir, 'postgres-persistence.json'), `${JSON.stringify({ baseline: BASELINE, migrationSha256: MIGRATION_SHA256, postgresVersion, scope: 'focused-current-operational-migration', scenarios: results }, null, 2)}\n`)],
      ...(client ? [['client-disconnect', () => client.$disconnect()]] : []),
      ['database-drop', () => admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`)],
      ['role-drop', () => admin.$executeRawUnsafe(`DROP ROLE IF EXISTS "${role}"`)],
      ['admin-disconnect', () => admin.$disconnect()],
      ['fixture-remove', () => rmSync(fixtureRoot, { recursive: true, force: true })],
      ['cleanup-report', () => t.diagnostic(JSON.stringify({ cleanup }))],
    ]) {
      try {
        await attempt();
        cleanup.push({ action, status: 'succeeded' });
      } catch (error) {
        let detail = error instanceof Error ? error.message : String(error);
        for (const secret of [databaseUrl.href, adminUrl.href, password, adminUrl.password].filter(Boolean)) detail = detail.replaceAll(secret, '[redacted]');
        detail = detail.replace(/postgres(?:ql)?:\/\/\S+/gu, '[redacted-dsn]').slice(-4_000);
        failures.push(new Error(`cleanup ${action} failed: ${detail}`));
        cleanup.push({ action, status: 'failed' });
      }
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'Preflight failures; see cleanup action outcomes', { cause: failures[0] });
});
