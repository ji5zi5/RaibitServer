import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import YAML from 'yaml';

const root = fileURLToPath(new URL('../', import.meta.url));
const chart = path.join(root, 'infra/helm/raibitserver');
const helm = process.argv[2] || process.env.HELM_BIN || 'helm';
const legacy = path.join(chart, 'ci-production-values.yaml');
assert.equal(YAML.parse(readFileSync(legacy, 'utf8')).domainRentals, undefined);
const settings = {
  'ingress.className': 'traefik', 'ingress.hosts.public': 'raibit.kr',
  'ingress.hosts.api': 'api.raibit.kr', 'ingress.hosts.dashboard': 'console.raibit.kr',
  'dashboard.consoleUrl': 'https://console.raibit.kr/console',
};
function render(extra = {}, production = true, failure) {
  const result = spawnSync(helm, ['template', 'raibitserver', chart, '--namespace', 'platform',
    ...(production ? ['-f', legacy] : []),
    ...Object.entries({ ...(production ? settings : {}), ...extra }).flatMap(([key, value]) => ['--set-json', `${key}=${JSON.stringify(value)}`]),
  ], { encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
  if (failure) { assert.notEqual(result.status, 0); assert.match(result.stderr, failure); return; }
  assert.equal(result.status, 0, result.stderr || String(result.error));
  return YAML.parseAllDocuments(result.stdout).map((doc) => { assert.deepEqual(doc.errors, []); return doc.toJSON(); }).filter(Boolean);
}
const named = (docs, name) => docs.find((doc) => doc.metadata?.name === name && doc.kind === 'Deployment') ?? docs.find((doc) => doc.metadata?.name === name);
const environment = (doc) => Object.fromEntries(doc.spec.template.spec.containers[0].env.filter((e) => 'value' in e).map((e) => [e.name, e.value]));
let cases = 0;
function check(name, work) { work(); cases++; console.log(`PASS ${name}`); }

check('legacy values alone automatically render rentals on the first production Traefik update', () => {
  const docs = render();
  const ingress = named(docs, 'raibitserver-domain-rentals');
  assert.equal(ingress.spec.rules[0].host, '*.raibit.kr');
  assert.equal(ingress.spec.rules[0].http.paths[0].backend.service.name, 'raibitserver-api');
  assert.equal(ingress.metadata.annotations['traefik.ingress.kubernetes.io/router.priority'], '2');
  assert.equal(ingress.spec.tls[0].secretName, 'ci-raibitserver-hosted-errors-tls');
  const api = named(docs, 'raibitserver-api');
  assert.equal(environment(api).RAIBITSERVER_DOMAIN_RENTAL_BASE_DOMAIN, 'raibit.kr');
  const migration = named(docs, 'raibitserver-migrate');
  assert.equal(migration.metadata.annotations['helm.sh/hook'], 'pre-install,pre-upgrade');
  const hook = named(docs, 'raibitserver-rental-check');
  assert.equal(hook.metadata.annotations['helm.sh/hook'], 'post-install,post-upgrade');
  assert.equal(hook.spec.template.spec.containers[0].image, api.spec.template.spec.containers[0].image);
  assert.equal(migration.spec.template.spec.containers[0].image, api.spec.template.spec.containers[0].image);
  assert.equal(hook.spec.template.spec.automountServiceAccountToken, false);
  assert.notEqual(hook.spec.template.metadata.labels['app.kubernetes.io/name'], 'raibitserver-api');
  assert.equal(hook.spec.template.spec.containers[0].args[1].trim(), readFileSync(path.join(chart, 'files/domain-rentals-upgrade-check.cjs'), 'utf8').trim());
  assert.equal(environment(hook).RAIBITSERVER_RENTAL_CHECK_API_URL, 'http://raibitserver-api:3000');
});
check('null or absent old values still select auto; explicit false is respected', () => {
  assert.ok(named(render({ domainRentals: null }), 'raibitserver-domain-rentals'));
  const off = render({ 'domainRentals.enabled': false });
  assert.equal(named(off, 'raibitserver-domain-rentals'), undefined);
  assert.equal(named(off, 'raibitserver-rental-check'), undefined);
});
check('local, disabled ingress and non-Traefik installs do not gain a wildcard unexpectedly', () => {
  for (const docs of [render({}, false), render({ 'ingress.className': 'nginx' }), render({ 'ingress.enabled': false }, false)]) {
    assert.equal(named(docs, 'raibitserver-domain-rentals'), undefined);
    assert.equal(named(docs, 'raibitserver-rental-check'), undefined);
  }
});
check('entrypoints and wildcard TLS are inherited without changing existing route priorities', () => {
  const docs = render({
    'ingress.annotations': { 'traefik.ingress.kubernetes.io/router.entrypoints': 'websecure' },
    'hostedErrors.fallbackIngress.annotations': { 'traefik.ingress.kubernetes.io/router.priority': '1', 'traefik.ingress.kubernetes.io/router.tls': 'true' },
  });
  const annotations = named(docs, 'raibitserver-domain-rentals').metadata.annotations;
  assert.equal(annotations['traefik.ingress.kubernetes.io/router.entrypoints'], 'websecure');
  assert.equal(annotations['traefik.ingress.kubernetes.io/router.tls'], 'true');
  assert.equal(annotations['traefik.ingress.kubernetes.io/router.priority'], '2');
  assert.equal(docs.find((d) => d.kind === 'Ingress' && d.metadata.name === 'raibitserver-hosted-errors').metadata.annotations['traefik.ingress.kubernetes.io/router.priority'], '1');
});
check('shared TLS fallback, custom wildcard base and platform reservations use the same config', () => {
  const docs = render({ 'hostedErrors.fallbackIngress.tls.existingSecret': '', 'ingress.hosts.api': 'control.raibit.kr' });
  assert.equal(named(docs, 'raibitserver-domain-rentals').spec.tls[0].secretName, 'ci-raibitserver-ingress-tls');
  assert.ok(environment(named(docs, 'raibitserver-api')).RAIBITSERVER_DOMAIN_RENTAL_RESERVED_NAMES.split(',').includes('control'));
  const custom = render({ 'hostedErrors.fallbackIngress.host': '*.links.example.org' });
  assert.equal(named(custom, 'raibitserver-domain-rentals').spec.rules[0].host, '*.links.example.org');
  assert.equal(environment(named(custom, 'raibitserver-api')).RAIBITSERVER_DOMAIN_RENTAL_BASE_DOMAIN, 'links.example.org');
});
check('explicit separate-domain opt-in and TLS overrides survive; invalid auto changes fail', () => {
  const docs = render({ 'domainRentals.enabled': true, 'domainRentals.baseDomain': 'links.example.org', 'domainRentals.tlsSecret': 'dedicated-wildcard' });
  assert.equal(named(docs, 'raibitserver-domain-rentals').spec.tls[0].secretName, 'dedicated-wildcard');
  render({ 'domainRentals.baseDomain': 'unconfigured.example.org' }, true, /reuse the existing wildcard/);
  render({ 'domainRentals.enabled': 'false' }, true, /true, false, or auto/);
  render({ 'domainRentals.baseDomain': 'https://raibit.kr' }, true, /must be a DNS domain/);
});
console.log(`domain-rental-helm: ${cases} scenario groups passed`);
