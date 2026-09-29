'use strict';

// Read-only post-upgrade check. Never create users, mint sessions, fetch a
// rental destination, or print a DSN/Prisma error containing credentials.
const { request: httpRequest } = require('node:http');
const { randomBytes } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');

async function verifyDatabase(client) {
  const [state] = await client.$queryRaw`
    SELECT to_regclass('"DomainRental"') IS NOT NULL AS "tableExists",
      EXISTS (SELECT 1 FROM "_prisma_migrations"
        WHERE migration_name = '202609291300_domain_rentals'
          AND finished_at IS NOT NULL AND rolled_back_at IS NULL) AS "migrationFinished",
      EXISTS (SELECT 1 FROM pg_trigger
        WHERE tgrelid = to_regclass('"DomainRental"')
          AND tgname = 'DomainRental_hostname_guard' AND tgenabled IN ('O', 'A')) AS "rentalGuard",
      EXISTS (SELECT 1 FROM pg_trigger
        WHERE tgrelid = to_regclass('"Domain"')
          AND tgname = 'Domain_rental_hostname_guard' AND tgenabled IN ('O', 'A')) AS "customGuard"`;
  if (!state || !['tableExists', 'migrationFinished', 'rentalGuard', 'customGuard'].every((key) => state[key] === true)) {
    throw new Error('DOMAIN_RENTAL_SCHEMA_NOT_READY');
  }
  // Exercise the generated client and columns without loading users or URLs.
  await client.domainRental.findFirst({ select: { id: true, ownerUserId: true, hostname: true, enabled: true, version: true } });
}

// Native fetch rewrites Host to the URL authority. The internal service URL
// and the public rental Host intentionally differ, so use node:http directly.
function internalRequest(url, { headers, signal }) {
  return new Promise((resolve, reject) => {
    if (url.protocol !== 'http:') return reject(new Error('INTERNAL_HTTP_REQUIRED'));
    const request = httpRequest(url, { method: 'GET', headers, signal }, (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > 65536) { response.destroy(new Error('CHECK_RESPONSE_TOO_LARGE')); return; }
        chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        const status = response.statusCode || 500;
        const headers = Object.fromEntries(Object.entries(response.headers)
          .filter(([, value]) => value !== undefined)
          .map(([key, value]) => [key, Array.isArray(value) ? value.join(', ') : value]));
        resolve(new Response([204, 205, 304].includes(status) ? null : Buffer.concat(chunks), { status, headers }));
      });
    });
    request.on('error', reject);
    request.end();
  });
}

async function verifyApi({ apiUrl, apiHost, baseDomain }, request = internalRequest) {
  const probeHost = `upgrade-${randomBytes(12).toString('hex')}.${baseDomain}`;
  const get = (path, host) => request(new URL(path, apiUrl), {
    method: 'GET', headers: { host }, redirect: 'manual', signal: AbortSignal.timeout(4_000),
  });
  const health = await get('/api/health', apiHost);
  await health.body?.cancel();
  if (health.status !== 200) throw new Error('DOMAIN_RENTAL_API_NOT_READY');
  const management = await get('/api/domain-rentals', apiHost);
  await management.body?.cancel();
  if (![401, 403].includes(management.status)) throw new Error('DOMAIN_RENTAL_AUTH_BOUNDARY_INVALID');
  const rental = await get('/', probeHost);
  const content = await rental.text();
  if (rental.status !== 404 || !rental.headers.get('cache-control')?.includes('no-store') || content !== 'This address is not available.') {
    throw new Error('DOMAIN_RENTAL_HOST_ROUTING_NOT_READY');
  }
}

async function main() {
  // The Job also has a Kubernetes deadline. This bounds DB stalls and retries.
  const deadline = setTimeout(() => { console.error('DOMAIN_RENTAL_UPGRADE_CHECK_TIMEOUT'); process.exit(1); }, 100_000);
  let client;
  try {
    const { PrismaClient } = require('@prisma/client');
    client = new PrismaClient({ log: [] });
    await verifyDatabase(client);
    const config = {
      apiUrl: process.env.RAIBITSERVER_RENTAL_CHECK_API_URL,
      apiHost: process.env.RAIBITSERVER_RENTAL_CHECK_API_HOST,
      baseDomain: process.env.RAIBITSERVER_DOMAIN_RENTAL_BASE_DOMAIN,
    };
    for (let attempt = 0; ; attempt++) {
      try { await verifyApi(config); break; }
      catch { if (attempt >= 11) throw new Error('DOMAIN_RENTAL_API_CHECK_FAILED'); await delay(2_000); }
    }
    console.log('DOMAIN_RENTAL_UPGRADE_CHECK_OK');
  } catch {
    console.error('DOMAIN_RENTAL_UPGRADE_CHECK_FAILED');
    process.exitCode = 1;
  } finally {
    if (client) await client.$disconnect().catch(() => { process.exitCode = 1; });
    clearTimeout(deadline);
  }
}
module.exports = { verifyDatabase, verifyApi };
if (require.main === module || process.env.RAIBITSERVER_RENTAL_RUN_UPGRADE_CHECK === '1') void main();
