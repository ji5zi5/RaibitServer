import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { DomainRentals, DomainRentalError, MemoryDomainRentalRepository, domainRentalConfig, domainRentalHostname, normalizeDomainRentalName, normalizeDomainRentalTarget } from '../packages/core/src/domain-rentals.ts';
import { handleDomainRentalRedirect } from '../packages/core/src/domain-rentals-http.ts';

const config = domainRentalConfig({});
function setup(accountType = 'NON_CLUB', occupied = async () => false) {
  const users = new Map([['u1', { id: 'u1', accountType, approvalStatus: 'APPROVED' }], ['u2', { id: 'u2', accountType: 'NON_CLUB', approvalStatus: 'APPROVED' }]]);
  const repository = new MemoryDomainRentalRepository(async (id) => users.get(id) || null, occupied);
  return { users, repository, engine: new DomainRentals(repository, config) };
}
const input = (name) => ({ name, targetUrl: 'https://example.com/path?v=0.3.0#readme' });
const code = (expected) => (error) => error instanceof DomainRentalError && error.code === expected;

test('names allow 1–63 characters, normalize case, and do not truncate', () => {
  assert.equal(normalizeDomainRentalName('  My-Project  ', config), 'my-project');
  assert.equal(normalizeDomainRentalName('a', config), 'a');
  assert.equal(normalizeDomainRentalName('a'.repeat(63), config).length, 63);
  for (const value of ['', 'a'.repeat(64), '-abc', 'abc-', 'a.b', 'a_b', '한글', '*', null, 123]) {
    assert.throws(() => normalizeDomainRentalName(value, config), code('DOMAIN_RENTAL_NAME_INVALID'));
  }
});
for (const name of ['api', 'app', 'www', 'admin', 'registry', 'apps--org--web', 'preview--pr-1--org', 'console--x', 'resources--x', 'xn--thing']) {
  test(`reserved platform name: ${name}`, () => assert.throws(() => normalizeDomainRentalName(name, config), code('DOMAIN_RENTAL_NAME_RESERVED')));
}
test('custom base domain and additional platform names are validated', () => {
  const custom = domainRentalConfig({ RAIBITSERVER_DOMAIN_RENTAL_BASE_DOMAIN: 'MY.EXAMPLE.COM.', RAIBITSERVER_DOMAIN_RENTAL_RESERVED_NAMES: 'school', RAIBITSERVER_API_URL: 'https://control.my.example.com/api' });
  assert.equal(custom.baseDomain, 'my.example.com');
  for (const name of ['school', 'control']) assert.throws(() => normalizeDomainRentalName(name, custom), code('DOMAIN_RENTAL_NAME_RESERVED'));
  assert.throws(() => domainRentalConfig({ RAIBITSERVER_DOMAIN_RENTAL_BASE_DOMAIN: 'http://raibit.kr' }));
});
test('only actual single-label rental hosts are selected', () => {
  assert.equal(domainRentalHostname('EXAMPLE.RAIBIT.KR:443', config), 'example.raibit.kr');
  for (const host of ['raibit.kr', 'api.raibit.kr', 'x.y.raibit.kr', 'x.raibit.kr.evil.com', 'x.raibit.kr,evil.com', 'evil.com', undefined]) assert.equal(domainRentalHostname(host, config), null);
});
test('destination preserves its path, query, fragment and supports platform apps', () => {
  const url = input('x').targetUrl;
  assert.equal(normalizeDomainRentalTarget(url, config), url);
  assert.equal(normalizeDomainRentalTarget('http://example.com', config), 'http://example.com/');
  assert.equal(normalizeDomainRentalTarget('https://apps--org--web.raibit.kr/', config), 'https://apps--org--web.raibit.kr/');
});
for (const target of ['javascript:alert(1)', 'data:text/html,hi', '//example.com', 'ftp://example.com', 'https://user:pass@example.com', 'https://example.com/\r\nX:1', 'https://example.com/%0d%0aX:1', 'https://example.com\\evil', 'http://localhost', 'http://127.0.0.1', 'http://2130706433', 'http://10.0.0.1', 'http://192.168.1.1', 'http://[::1]', 'http://[::ffff:7f00:1]', 'http://[fe80::1]', 'http://service.internal']) {
  test(`reject unsafe destination: ${JSON.stringify(target)}`, () => assert.throws(() => normalizeDomainRentalTarget(target, config), code('DOMAIN_RENTAL_TARGET_INVALID')));
}
test('self and cross-rental loops are rejected before a name is claimed', () => {
  for (const url of ['https://self.raibit.kr/', 'https://OTHER.raibit.kr:443/path', 'https://other.raibit.kr./']) assert.throws(() => normalizeDomainRentalTarget(url, config), code('DOMAIN_RENTAL_REDIRECT_LOOP'));
});
for (const [accountType, limit] of [['NON_CLUB', 2], ['CLUB_MEMBER', 5]]) {
  test(`${accountType}: simultaneous requests cannot exceed ${limit}`, async () => {
    const { engine } = setup(accountType);
    const attempts = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => engine.create('u1', input(`name-${i}`))));
    assert.equal(attempts.filter((result) => result.status === 'fulfilled').length, limit);
    for (const result of attempts.filter((result) => result.status === 'rejected')) assert.equal(result.reason.code, 'DOMAIN_RENTAL_QUOTA_EXCEEDED');
    assert.equal((await engine.list('u1')).used, limit);
  });
}
test('admin status and input claims do not bypass the account quota', async () => {
  const { engine, users } = setup();
  users.get('u1').role = 'ADMIN';
  await assert.rejects(engine.create('u1', { ...input('test'), accountType: 'CLUB_MEMBER' }), code('DOMAIN_RENTAL_INPUT_INVALID'));
  await engine.create('u1', input('one')); await engine.create('u1', input('two'));
  await assert.rejects(engine.create('u1', input('three')), code('DOMAIN_RENTAL_QUOTA_EXCEEDED'));
});
test('global names are unique across owners under concurrency', async () => {
  const { engine } = setup();
  const results = await Promise.allSettled(['u1', 'u2'].map((id) => engine.create(id, input('same'))));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.find((r) => r.status === 'rejected').reason.code, 'DOMAIN_RENTAL_NAME_TAKEN');
});
test('names occupied by existing custom domains are blocked', async () => {
  const { engine } = setup('NON_CLUB', async (host) => host === 'taken.raibit.kr');
  await assert.rejects(engine.create('u1', input('taken')), code('DOMAIN_RENTAL_NAME_TAKEN'));
});
test('owners can update target, rename, pause, resume and delete; disabled names count', async () => {
  const { engine, repository } = setup();
  const first = await engine.create('u1', input('first'));
  await engine.create('u1', input('second'));
  const edited = await engine.update('u1', first.id, { expectedVersion: 1, name: 'renamed', targetUrl: 'https://example.org/new?q=1', enabled: false });
  assert.equal(edited.version, 2);
  assert.equal(await engine.resolve('first.raibit.kr'), null);
  assert.equal(await engine.resolve('renamed.raibit.kr'), null);
  await assert.rejects(engine.create('u1', input('third')), code('DOMAIN_RENTAL_QUOTA_EXCEEDED'));
  await engine.update('u1', first.id, { expectedVersion: 2, enabled: true });
  assert.equal(await engine.resolve('renamed.raibit.kr'), 'https://example.org/new?q=1');
  await engine.remove('u1', first.id, { expectedVersion: 3 });
  assert.equal(await engine.resolve('renamed.raibit.kr'), null);
  await engine.create('u2', input('renamed'));
  assert.equal((await engine.list('u1')).remaining, 1);
  assert.deepEqual(repository.events.slice(0, 5).map((e) => e.action), ['domain-rental.create', 'domain-rental.create', 'domain-rental.update', 'domain-rental.update', 'domain-rental.delete']);
});
test('cross-user reads/mutations and stale writes are rejected', async () => {
  const { engine } = setup();
  const rental = await engine.create('u1', input('mine'));
  assert.equal((await engine.list('u2')).rentals.length, 0);
  await assert.rejects(engine.update('u2', rental.id, { expectedVersion: 1, enabled: false }), code('DOMAIN_RENTAL_NOT_FOUND'));
  await assert.rejects(engine.remove('u2', rental.id, { expectedVersion: 1 }), code('DOMAIN_RENTAL_NOT_FOUND'));
  await assert.rejects(engine.update('u1', rental.id, { enabled: false }), code('DOMAIN_RENTAL_VERSION_REQUIRED'));
  await engine.update('u1', rental.id, { expectedVersion: 1, enabled: false });
  await assert.rejects(engine.remove('u1', rental.id, { expectedVersion: 1 }), code('DOMAIN_RENTAL_VERSION_CONFLICT'));
});
test('renaming cannot take another owner name', async () => {
  const { engine } = setup();
  const a = await engine.create('u1', input('one'));
  await engine.create('u2', input('two'));
  await assert.rejects(engine.update('u1', a.id, { expectedVersion: 1, name: 'TWO' }), code('DOMAIN_RENTAL_NAME_TAKEN'));
});
test('fresh account type controls creation and downgrade does not delete data', async () => {
  const { engine, users } = setup('CLUB_MEMBER');
  for (let i = 0; i < 5; i++) await engine.create('u1', input(`site-${i}`));
  users.get('u1').accountType = 'NON_CLUB';
  const list = await engine.list('u1');
  assert.equal(list.limit, 2); assert.equal(list.used, 5);
  assert.equal(list.rentals.filter((r) => r.quotaSuspended).length, 3);
  const results = await Promise.all(list.rentals.map((r) => engine.resolve(r.hostname)));
  assert.equal(results.filter(Boolean).length, 2);
  await assert.rejects(engine.create('u1', input('extra')), code('DOMAIN_RENTAL_QUOTA_EXCEEDED'));
});
test('pending, deleted and actively banned users cannot create or redirect', async () => {
  const { engine, users } = setup();
  await engine.create('u1', input('mine'));
  users.get('u1').approvalStatus = 'PENDING';
  assert.equal(await engine.resolve('mine.raibit.kr'), null);
  await assert.rejects(engine.create('u1', input('x')), code('DOMAIN_RENTAL_ACCOUNT_UNAVAILABLE'));
  users.get('u1').approvalStatus = 'APPROVED'; users.get('u1').bannedAt = new Date().toISOString();
  assert.equal(await engine.resolve('mine.raibit.kr'), null);
  users.get('u1').banExpiresAt = '2000-01-01T00:00:00Z';
  assert.equal(await engine.resolve('mine.raibit.kr'), input('mine').targetUrl);
  users.delete('u1'); assert.equal(await engine.resolve('mine.raibit.kr'), null);
});
test('audit failure rolls back a creation and releases quota', async () => {
  const { engine, repository } = setup();
  repository.audit = async () => { throw new Error('audit unavailable'); };
  await assert.rejects(engine.create('u1', input('rollback')), /audit unavailable/);
  assert.equal((await engine.list('u1')).used, 0);
});
test('actual HTTP: GET/HEAD redirect, no cache, no query leakage, no Host spoofing, method guard, deleted 404', async () => {
  const { engine } = setup();
  const rental = await engine.create('u1', input('hello'));
  const server = http.createServer((req, res) => {
    void handleDomainRentalRedirect(engine, req, res).then((handled) => { if (!handled) { res.statusCode = 200; res.end('api'); } });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const request = (host, method = 'GET', headers = {}) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: '/private?secret=do-not-leak', method, headers: { host, ...headers } }, (res) => {
      let body = ''; res.on('data', (chunk) => { body += chunk; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }); req.on('error', reject); req.end();
  });
  try {
    const get = await request('hello.raibit.kr');
    assert.equal(get.status, 302); assert.equal(get.headers.location, input('hello').targetUrl);
    assert.match(get.headers['cache-control'], /no-store/); assert.equal(get.headers['referrer-policy'], 'no-referrer');
    assert.equal(get.headers['set-cookie'], undefined);
    const head = await request('hello.raibit.kr', 'HEAD'); assert.equal(head.status, 302); assert.equal(head.body, '');
    const post = await request('hello.raibit.kr', 'POST'); assert.equal(post.status, 405); assert.equal(post.headers.location, undefined);
    const spoof = await request('api.raibit.kr', 'GET', { 'x-forwarded-host': 'hello.raibit.kr' }); assert.equal(spoof.body, 'api');
    assert.equal((await request('unknown.raibit.kr')).status, 404);
    await engine.remove('u1', rental.id, { expectedVersion: 1 });
    assert.equal((await request('hello.raibit.kr')).status, 404);
  } finally { server.close(); await once(server, 'close'); }
});
