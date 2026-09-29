import test from 'node:test';
import { createRequire } from 'node:module';
// Register the existing Nest TypeScript loader, not its unprefixed
// parity server. This test reproduces main.ts's production routing.
import './fixtures/api-parity-runtime.mjs';
const require = createRequire(new URL('../apps/api/package.json', import.meta.url));
const { NestFactory } = require('@nestjs/core');
const { AppModule } = require('./src/app.module.ts');
const { DomainRentalsService } = require('./src/modules/domain-rentals/domain-rentals.module.ts');
const { verifyApi } = createRequire(import.meta.url)('../infra/helm/raibitserver/files/domain-rentals-upgrade-check.cjs');
test('post-upgrade probe validates real Nest with production prefix and Host middleware', async (t) => {
  process.env.NODE_ENV = 'test';
  process.env.RAIBITSERVER_AUTH_MODE = 'jwt';
  process.env.RAIBITSERVER_AUTH_JWT_SECRET = 'local-upgrade-probe-test-secret-only';
  process.env.RAIBITSERVER_ALLOW_MEMORY_PERSISTENCE = '1';
  process.env.RAIBITSERVER_DOMAIN_RENTAL_BASE_DOMAIN = 'raibit.kr';
  delete process.env.DATABASE_URL;
  const app = await NestFactory.create(AppModule, { logger: false, rawBody: true, abortOnError: false });
  t.after(() => app.close());
  const rentals = app.get(DomainRentalsService);
  app.use((req, res, next) => {
    void rentals.redirect(req, res).then((handled) => { if (!handled) next(); }).catch(next);
  });
  app.setGlobalPrefix('api');
  await app.listen(0, '127.0.0.1');
  await verifyApi({ apiUrl: await app.getUrl(), apiHost: 'api.raibit.kr', baseDomain: 'raibit.kr' });
});
