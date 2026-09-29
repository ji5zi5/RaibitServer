import assert from 'node:assert/strict';
import { hashPassword } from '../../packages/core/src/identity.ts';
import { bootParityApi } from './api-parity-runtime.mjs';

/** Real Nest module + real JWT guards; only persistence and credentials are local. */
export async function bootRentalRuntime() {
  process.env.RAIBITSERVER_BASE_DOMAIN = 'raibitserver.app';
  process.env.RAIBITSERVER_DOMAIN_RENTAL_BASE_DOMAIN = 'raibit.kr';
  const runtime = await bootParityApi();
  const store = runtime.repository.store;
  const password = 'rental-local-test-password';
  const passwordHash = hashPassword(password);
  const organization = store.createOrganization({ name: 'Rental tests', slug: 'rental-tests' });
  const project = store.createProject({ organizationId: organization.id, name: 'Web', slug: 'web' });
  const service = store.createService({ projectId: project.id, name: 'Web', type: 'web' });
  const request = async (token, path, body, method = body === undefined ? 'GET' : 'POST') => {
    const response = await fetch(runtime.baseUrl + path, {
      method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000),
    });
    return { status: response.status, body: await response.json() };
  };
  const account = async (name, accountType = 'NON_CLUB') => {
    const user = store.createUser({ name, email: `${name}@example.test`, passwordHash, role: 'USER', accountType,
      approvalStatus: 'APPROVED', emailVerifiedAt: new Date().toISOString() });
    store.addMember({ userId: user.id, organizationId: organization.id, role: 'OWNER' });
    const session = await request(null, '/auth/login', { email: user.email, password });
    assert.equal(session.status, 201, JSON.stringify(session.body));
    assert.ok(session.body.token);
    return { user, token: session.body.token };
  };
  return { ...runtime, store, project, service, account, request, close: () => runtime.app.close() };
}
