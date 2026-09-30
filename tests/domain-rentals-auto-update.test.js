import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { verifyDatabase, verifyApi } = require('../infra/helm/raibitserver/files/domain-rentals-upgrade-check.cjs');
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const config = { apiUrl: 'http://raibitserver-api:3000', apiHost: 'control.raibit.kr', baseDomain: 'raibit.kr' };

test('the first update installs rental routes and hooks before replacing the installed updater', () => {
  const updater = read('deploy/production/auto-update.sh');
  const upgrade = updater.indexOf('helm upgrade --install');
  const refresh = updater.indexOf('mv -- "$UPDATER_TMP" "$UPDATER_LIBEXEC_PATH"');
  const success = updater.indexOf('>"${STATE_DIR}/deployed-sha.tmp"');
  assert.ok(upgrade > 0 && refresh > upgrade && success > refresh);
  assert.doesNotMatch(updater, /--reuse-values|--no-hooks|--skip-schema-validation/);
  const helper = read('infra/helm/raibitserver/templates/_domain-rentals.tpl');
  assert.match(helper, /\$mode := "auto"/);
  assert.match(helper, /kindIs "bool" \$mode/);
  assert.match(read('infra/helm/raibitserver/templates/migration-job.yaml'), /pre-install,pre-upgrade/);
  const check = read('infra/helm/raibitserver/templates/domain-rentals-upgrade-check.yaml');
  assert.match(check, /post-install,post-upgrade/);
  assert.match(check, /automountServiceAccountToken: false/);
  assert.match(check, /readOnlyRootFilesystem: true/);
  assert.doesNotMatch(check, /envFrom:|hostNetwork:|hostPath:|privileged: true/);
});

for (const missing of ['tableExists', 'migrationFinished', 'rentalGuard', 'customGuard']) {
  test(`upgrade check refuses a missing ${missing}`, async () => {
    const state = { tableExists: true, migrationFinished: true, rentalGuard: true, customGuard: true, [missing]: false };
    await assert.rejects(verifyDatabase({ $queryRaw: async () => [state] }), /SCHEMA_NOT_READY/);
  });
}
test('upgrade schema check uses the generated Prisma client without writes', async () => {
  let reads = 0;
  await verifyDatabase({
    $queryRaw: async (sql) => {
      assert.match(sql.join(''), /202609291300_domain_rentals/);
      assert.doesNotMatch(sql.join(''), /INSERT|UPDATE|DELETE|DROP|ALTER/);
      return [{ tableExists: true, migrationFinished: true, rentalGuard: true, customGuard: true }];
    },
    domainRental: { findFirst: async ({ select }) => { reads++; assert.equal(select.version, true); assert.equal(select.targetUrl, undefined); } },
  });
  assert.equal(reads, 1);
});

function requests(overrides = {}) {
  const calls = [];
  const request = async (url, options) => {
    calls.push({ url: url.href, options });
    if (url.pathname === '/api/health') return new Response('', { status: overrides.health ?? 200 });
    if (url.pathname === '/api/domain-rentals') return new Response('', { status: overrides.management ?? 401 });
    return new Response(overrides.body ?? 'This address is not available.', {
      status: overrides.rental ?? 404,
      headers: { 'cache-control': overrides.cache ?? 'no-store, max-age=0' },
    });
  };
  return { calls, request };
}
test('upgrade probes use only internal HTTP, preserve Host and never forward credentials or follow redirects', async () => {
  const { calls, request } = requests();
  await verifyApi(config, request);
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.equal(new URL(call.url).host, 'raibitserver-api:3000');
    assert.equal(call.options.redirect, 'manual');
    assert.deepEqual(Object.keys(call.options.headers), ['host']);
    assert.ok(call.options.signal instanceof AbortSignal);
  }
  assert.equal(calls[0].options.headers.host, 'control.raibit.kr');
  assert.match(calls[2].options.headers.host, /^upgrade-[a-f0-9]{24}\.raibit\.kr$/);
});
for (const [overrides, failure] of [
  [{ health: 503 }, /API_NOT_READY/],
  [{ management: 200 }, /AUTH_BOUNDARY_INVALID/],
  [{ management: 404 }, /AUTH_BOUNDARY_INVALID/],
  [{ rental: 503 }, /HOST_ROUTING_NOT_READY/],
  [{ rental: 302 }, /HOST_ROUTING_NOT_READY/],
  [{ cache: 'public' }, /HOST_ROUTING_NOT_READY/],
  [{ body: '<h1>Not Found</h1>' }, /HOST_ROUTING_NOT_READY/],
]) {
  test(`upgrade check fails closed for ${JSON.stringify(overrides)}`, async () => {
    await assert.rejects(verifyApi(config, requests(overrides).request), failure);
  });
}
