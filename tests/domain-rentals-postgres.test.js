import test from 'node:test';
import assert from 'node:assert/strict';
import { DomainRentals, domainRentalConfig } from '../packages/core/src/domain-rentals.ts';
import { PostgresDomainRentalRepository } from '../packages/core/src/domain-rentals-postgres.ts';

function fixture() {
  const calls = [];
  const row = { id: 'r1', ownerUserId: 'u1', hostname: 'mine.raibit.kr', targetUrl: 'https://example.com/?private=token', enabled: true, version: 1, createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01') };
  const tx = {
    $queryRaw: async (strings, id) => { calls.push(['lock', strings.join('?'), id]); return [{ id }]; },
    user: { findUnique: async () => { calls.push(['user']); return { id: 'u1', approvalStatus: 'APPROVED', accountType: 'NON_CLUB' }; } },
    domainRental: {
      findMany: async () => { calls.push(['list']); return []; },
      findUnique: async () => null,
      create: async (args) => { calls.push(['create', args]); },
      updateMany: async (args) => { calls.push(['update', args]); return { count: 1 }; },
      delete: async (args) => { calls.push(['delete', args]); },
    },
    domain: { findFirst: async () => null },
    auditLog: { create: async (args) => { calls.push(['audit', args]); } },
  };
  const client = { ...tx, $transaction: async (work, options) => { calls.push(['transaction', options]); return work(tx); }, $disconnect: async () => { calls.push(['disconnect']); } };
  return { calls, tx, client, row, repository: new PostgresDomainRentalRepository(client) };
}

test('Postgres contract locks User before authoritative quota read and writes audit in the same transaction', async () => {
  const { calls, repository } = fixture();
  const engine = new DomainRentals(repository, domainRentalConfig({}));
  await engine.create('u1', { name: 'new', targetUrl: 'https://example.com/?private=token' });
  assert.deepEqual(calls.map(([name]) => name), ['transaction', 'lock', 'user', 'list', 'create', 'audit']);
  assert.match(calls[1][1], /FOR UPDATE/); assert.equal(calls[1][2], 'u1');
  assert.equal(calls[0][1].isolationLevel, 'ReadCommitted');
  assert.doesNotMatch(JSON.stringify(calls.at(-1)), /private|targetUrl|token/);
});
test('Postgres view serializes dates and update predicates bind owner and previous version', async () => {
  const { tx, calls, repository, row } = fixture();
  tx.domainRental.findUnique = async () => row;
  assert.equal((await repository.find('r1')).createdAt, '2026-01-01T00:00:00.000Z');
  await repository.update({ ...row, version: 2, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() });
  assert.deepEqual(calls.find(([name]) => name === 'update')[1].where, { id: 'r1', ownerUserId: 'u1', version: 1 });
  tx.domainRental.updateMany = async () => ({ count: 0 });
  await assert.rejects(repository.update({ ...row, version: 2 }), /DOMAIN_RENTAL_VERSION_CONFLICT/);
});
test('Postgres unique conflicts become a safe 409 and disconnection is explicit', async () => {
  const { repository, calls } = fixture();
  for (const error of [{ code: 'P2002' }, { code: 'P2010', meta: { code: '23505' } }]) {
    await assert.rejects(repository.withOwner('u1', async () => { throw error; }), (e) => e.statusCode === 409 && e.code === 'DOMAIN_RENTAL_NAME_TAKEN');
  }
  await repository.disconnect(); assert.equal(calls.at(-1)[0], 'disconnect');
});
