import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, cp, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../', import.meta.url));
const url = process.env.RAIBITSERVER_TEST_DATABASE_URL;
const required = process.env.RAIBITSERVER_REQUIRE_DOMAIN_RENTAL_UPGRADE_TEST === '1';
const migration = '202609291300_domain_rentals';

test('real PostgreSQL upgrades the pre-rental schema, keeps users/data, and safely repeats migrate deploy', {
  skip: !url && !required, timeout: 120_000,
}, async () => {
  assert.ok(url, 'RAIBITSERVER_TEST_DATABASE_URL is required by the upgrade gate');
  const { PrismaClient } = require('@prisma/client');
  const { verifyDatabase } = require('../infra/helm/raibitserver/files/domain-rentals-upgrade-check.cjs');
  const { DomainRentals, domainRentalConfig } = await import('../packages/core/src/domain-rentals.ts');
  const { PostgresDomainRentalRepository } = await import('../packages/core/src/domain-rentals-postgres.ts');
  const admin = new PrismaClient({ datasources: { db: { url } } });
  const name = `domain_upgrade_${randomUUID().replaceAll('-', '')}`;
  assert.match(name, /^domain_upgrade_[a-f0-9]{32}$/);
  const targetUrl = new URL(url); targetUrl.pathname = `/${name}`;
  const work = await mkdtemp(path.join(tmpdir(), 'raibit-rental-upgrade-'));
  let client, created = false;
  function migrate(schema) {
    const result = spawnSync(process.execPath, [require.resolve('prisma/build/index.js'), 'migrate', 'deploy', '--schema', schema], {
      env: { ...process.env, DATABASE_URL: targetUrl.href }, encoding: 'utf8', timeout: 45_000,
    });
    assert.equal(result.status, 0, 'prisma migrate deploy failed in the disposable test database');
  }
  try {
    // Never alter the supplied database: only this random disposable child DB.
    await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`); created = true;
    await cp(path.join(root, 'prisma'), path.join(work, 'prisma'), { recursive: true });
    await rm(path.join(work, 'prisma/migrations', migration), { recursive: true });
    migrate(path.join(work, 'prisma/schema.prisma'));
    client = new PrismaClient({ datasources: { db: { url: targetUrl.href } } });
    const oldUser = await client.user.create({ data: { email: 'before-upgrade@example.test', accountType: 'NON_CLUB', approvalStatus: 'APPROVED' } });
    await assert.rejects(verifyDatabase(client), /SCHEMA_NOT_READY/);
    migrate(path.join(root, 'prisma/schema.prisma'));
    await verifyDatabase(client);
    assert.equal((await client.user.findUnique({ where: { id: oldUser.id } })).email, oldUser.email);
    const club = await client.user.create({ data: { email: 'club-upgrade@example.test', accountType: 'CLUB_MEMBER', approvalStatus: 'APPROVED' } });
    const engine = new DomainRentals(new PostgresDomainRentalRepository(client), domainRentalConfig({}));
    for (const [user, limit] of [[oldUser, 2], [club, 5]]) {
      const attempts = await Promise.allSettled(Array.from({ length: 7 }, (_, i) => engine.create(user.id, {
        name: `upgrade-${limit}-${i}`, targetUrl: 'https://example.org/docs?v=1',
      })));
      assert.equal(attempts.filter((r) => r.status === 'fulfilled').length, limit);
      for (const failed of attempts.filter((r) => r.status === 'rejected')) assert.equal(failed.reason.code, 'DOMAIN_RENTAL_QUOTA_EXCEEDED');
    }
    const snapshot = await client.domainRental.findMany({ orderBy: { id: 'asc' } });
    await client.$disconnect();
    migrate(path.join(root, 'prisma/schema.prisma'));
    client = new PrismaClient({ datasources: { db: { url: targetUrl.href } } });
    await verifyDatabase(client);
    assert.deepEqual(await client.domainRental.findMany({ orderBy: { id: 'asc' } }), snapshot);
    assert.equal(await client.user.count(), 2);
    const rows = await client.$queryRaw`SELECT count(*)::int AS count FROM "_prisma_migrations" WHERE migration_name = ${migration} AND finished_at IS NOT NULL`;
    assert.equal(rows[0].count, 1);
    console.log('legacy-schema -> migrate deploy -> quotas 2/5 -> repeat migrate -> restart: PASS');
  } finally {
    await client?.$disconnect();
    if (created) await admin.$executeRawUnsafe(`DROP DATABASE "${name}" WITH (FORCE)`);
    await admin.$disconnect();
    await rm(work, { recursive: true, force: true });
  }
});
