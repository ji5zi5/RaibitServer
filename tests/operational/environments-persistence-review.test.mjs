import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryControlPlaneRepository, PrismaControlPlaneRepository } from '../../packages/core/src/persistence.ts';
import { developmentEnvironmentOperationId } from '../../packages/core/src/environments.ts';
import { stableId } from '../../packages/core/src/ids.ts';
import { decodeDeploymentHistoryCursor, encodeDeploymentHistoryCursor, parseDeploymentHistoryQuery } from '../../packages/core/src/deployment-history.ts';

async function fixture() {
  const repository = new InMemoryControlPlaneRepository();
  const organization = await repository.createOrganization({ name: 'Persistence review', slug: 'persistence-review' });
  const project = await repository.createProject({ organizationId: organization.id, name: 'Review', slug: 'review' });
  const dev = await repository.createEnvironment({ projectId: project.id, kind: 'dev', expectedVersion: 0 });
  const prod = await repository.resolveEnvironment(project.id);
  return { repository, organization, project, prod, dev };
}

async function historyFixture() {
  const context = await fixture();
  const { repository, project, prod, dev, organization } = context;
  const createdAt = '2026-09-13T00:00:00.000Z';
  for (const environment of [prod, dev]) {
    const service = await repository.createService({ projectId: project.id, environmentId: environment.id, name: 'web', sourceType: 'image', image: 'example/web:v1' });
    for (const suffix of ['c', 'b', 'a']) await repository.createDeployment({ id: `${environment.kind}-${suffix}`, serviceId: service.id, projectId: project.id, status: 'READY', createdAt, updatedAt: createdAt, deploymentType: 'production' });
    await repository.createDeployment({ id: `${environment.kind}-preview`, serviceId: service.id, projectId: project.id, status: 'READY', createdAt, updatedAt: createdAt, deploymentType: 'preview' });
  }
  return { ...context, scope: { organizationId: organization.id, projectId: project.id, cursorSecret: 'persistence-review-cursor', execute: false } };
}

test('project deployment list defaults to prod before pagination when dev rows are present', async () => {
  // Given both environments with the same creation timestamps.
  const { repository, project, prod } = await historyFixture();
  // When the public repository lists the project without a selector.
  const rows = await repository.listDeploymentsForProject(project.id, { limit: 20 });
  // Then only the four production-environment rows are visible.
  assert.equal(rows.length, 4);
  assert.ok(rows.every(row => row.environmentId === prod.id));
});

test('project deployment list selects dev before a one-row limit', async () => {
  // Given prod and dev rows where prod sorts ahead by id.
  const { repository, project, dev } = await historyFixture();
  // When the first dev row is requested.
  const rows = await repository.listDeploymentsForProject(project.id, { environmentId: dev.id, limit: 1 });
  // Then the page is populated only from dev.
  assert.equal(rows.length, 1);
  assert.equal(rows[0].environmentId, dev.id);
});

for (const kind of ['prod', 'dev']) test(`history retains production filter within selected ${kind} environment`, async () => {
  // Given production and preview deployment types in both project environments.
  const { repository, scope, prod, dev } = await historyFixture();
  const selected = kind === 'prod' ? prod : dev;
  // When history is filtered using its legacy production deployment type.
  const page = await repository.listDeploymentHistory({ ...scope, ...(kind === 'dev' ? { environmentId: selected.id } : {}), query: parseDeploymentHistoryQuery({ environment: 'production', limit: 100 }) });
  // Then the project environment and deployment type remain separate identities.
  assert.deepEqual(page.deployments.map(row => row.id), [`${kind}-c`, `${kind}-b`, `${kind}-a`]);
  assert.ok(page.deployments.every(row => row.environment === 'production' && row.environmentId === selected.id && row.environmentKind === kind));
  assert.equal(page.filters.environment, 'production');
});

test('history preserves preview selection inside dev and rejects foreign environment IDs', async () => {
  // Given both deployment types in a dev environment.
  const { repository, scope, dev } = await historyFixture();
  // When preview history is selected by authoritative environment ID.
  const page = await repository.listDeploymentHistory({ ...scope, environmentId: dev.id, query: parseDeploymentHistoryQuery({ environment: 'preview' }) });
  // Then only its preview lineage is returned and a foreign selector fails closed.
  assert.deepEqual(page.deployments.map(row => row.id), ['dev-preview']);
  await assert.rejects(repository.listDeploymentHistory({ ...scope, environmentId: 'env_dev_foreign', query: parseDeploymentHistoryQuery({}) }), error => error.code === 'ENVIRONMENT_NOT_FOUND' && error.statusCode === 404);
});

test('history cursors paginate matching dev scope without gaps and reject prod reuse', async () => {
  // Given a first dev page with a signed continuation cursor.
  const { repository, scope, dev, prod } = await historyFixture();
  const query = parseDeploymentHistoryQuery({ environment: 'production', limit: 2 });
  const first = await repository.listDeploymentHistory({ ...scope, environmentId: dev.id, query });
  assert.ok(first.page.nextCursor);
  // When the next page uses the same selector, then all remaining dev rows continue once.
  const second = await repository.listDeploymentHistory({ ...scope, environmentId: dev.id, query: { ...query, cursor: first.page.nextCursor } });
  assert.deepEqual([...first.deployments, ...second.deployments].map(row => row.id), ['dev-c', 'dev-b', 'dev-a']);
  assert.equal(second.page.nextCursor, null);
  await assert.rejects(repository.listDeploymentHistory({ ...scope, environmentId: prod.id, query: { ...query, cursor: first.page.nextCursor } }), error => error.code === 'INVALID_DEPLOYMENT_HISTORY_QUERY');
});

test('public cursor codec binds project environment in addition to tenant and filters', () => {
  // Given a signed dev cursor constructed by the production codec.
  const scope = { organizationId: 'org', projectId: 'project', environmentId: 'env-dev', environmentKind: 'dev', cursorSecret: 'secret' };
  const query = parseDeploymentHistoryQuery({ environment: 'production' });
  const position = { at: '2026-09-13T00:00:00.000Z', id: 'deployment' };
  const cursor = encodeDeploymentHistoryCursor(position, scope, query);
  // When it is decoded against each requested scope.
  assert.deepEqual(decodeDeploymentHistoryCursor(cursor, scope, query), position);
  // Then changing environment, project, organization or legacy filter is rejected.
  for (const changed of [{ environmentId: 'env-prod', environmentKind: 'prod' }, { projectId: 'foreign' }, { organizationId: 'foreign' }]) {
    assert.throws(() => decodeDeploymentHistoryCursor(cursor, { ...scope, ...changed }, query), error => error.code === 'INVALID_DEPLOYMENT_HISTORY_QUERY');
  }
  assert.throws(() => decodeDeploymentHistoryCursor(cursor, scope, { ...query, environment: 'preview' }), error => error.code === 'INVALID_DEPLOYMENT_HISTORY_QUERY');
});

async function githubFixture() {
  const context = await fixture();
  const { repository, organization, project, dev } = context;
  const user = await repository.createUser({ name: 'Owner', email: 'persistence-owner@example.test', approvalStatus: 'APPROVED', role: 'USER', accountType: 'NON_CLUB' });
  await repository.addMember({ userId: user.id, organizationId: organization.id, role: 'OWNER' });
  await repository.setQuota({ userId: user.id, maxProjects: 1, maxServices: 1, maxCpuMillicores: 10000, maxMemoryMb: 10000 });
  const integration = repository.store.connectVerifiedGitHubInstallation({ organizationId: organization.id, userId: user.id, installationId: '77001', accountLogin: 'review' });
  repository.store.replaceGitHubInstallationRepositories({ installationId: '77001', repositories: [{ githubRepoId: '77002', fullName: 'review/web', defaultBranch: 'main', private: false }] });
  const input = { projectId: project.id, integrationId: integration.id, repositoryId: '77002', serviceName: 'web', environmentId: dev.id, branch: 'main', idempotencyKey: 'persistence-import', actorUserId: user.id };
  return { ...context, user, input };
}

test('GitHub import counts a new dev service when the prod logical name already consumes quota', async () => {
  // Given one prod web service and a shared one-service quota.
  const { repository, project, user, input } = await githubFixture();
  await repository.createService({ projectId: project.id, name: 'web', sourceType: 'image', image: 'example/web:v1', actorUserId: user.id });
  // When the same logical service is imported into dev.
  await assert.rejects(repository.importGitHubRepository(input), error => error.statusCode === 403);
  // Then admission creates no extra service or binding.
  assert.equal(repository.store.services.size, 1);
  assert.equal(repository.store.environmentServices.size, 1);
});

test('GitHub import counts explicit serviceSlug rather than an existing matching display name', async () => {
  // Given dev web at the limit, with another explicit logical slug requested.
  const { repository, project, dev, user, input } = await githubFixture();
  await repository.createService({ projectId: project.id, environmentId: dev.id, name: 'web', sourceType: 'image', image: 'example/web:v1', actorUserId: user.id });
  // When import requests a distinct logical serviceSlug under the same name.
  await assert.rejects(repository.importGitHubRepository({ ...input, serviceSlug: 'another-web' }), error => error.statusCode === 403);
  // Then quota is still shared and no row was inserted.
  assert.equal(repository.store.services.size, 1);
});

test('GitHub import replay at quota returns the same custom-slug dev service', async () => {
  // Given a completed import that fills the one-service quota.
  const { repository, input } = await githubFixture();
  const request = { ...input, serviceSlug: 'custom-web' };
  const first = await repository.importGitHubRepository(request);
  // When the same idempotent request is replayed.
  const replay = await repository.importGitHubRepository(request);
  // Then the existing binding incurs no second service quota charge.
  assert.equal(replay.service.id, first.service.id);
  assert.equal(repository.store.services.size, 1);
  await assert.rejects(repository.importGitHubRepository({ ...request, branch: 'develop' }), error => error.statusCode === 409);
});

for (const mode of ['clean', 'conflicting', 'immutable-replay']) test(`round2 memory workflow stamps admitted target and snapshot: ${mode}`, async () => {
  // Given an actual dev service, independent of caller workflow identity labels.
  const { repository, project, dev } = await fixture();
  const service = await repository.createService({ projectId: project.id, environmentId: dev.id, name: 'web', sourceType: 'image', image: 'example/web:v1' });
  const immutable = { id: service.id, projectId: project.id, environmentId: dev.id, environmentKind: 'dev', kind: 'dev', image: 'example/web:original' };
  const payload = mode === 'clean' ? {} : { deploymentId: 'foreign-deployment', serviceId: 'foreign-service', projectId: 'foreign-project', environmentId: 'foreign-prod', environmentKind: 'prod', kind: 'prod', desiredSpecSnapshot: { image: 'example/foreign:v9' }, snapshotVersion: 99 };
  // When the public repository admits a workflow, including an immutable replay snapshot.
  const { deployment, workflowJob } = await repository.createDeploymentWorkflow({
    deployment: { serviceId: service.id, projectId: project.id, ...(mode === 'immutable-replay' ? { desiredSpecSnapshot: immutable, snapshotVersion: 1 } : {}) },
    workflow: { payload: { ...payload, correlation: 'preserved' } },
  });
  // Then payload authority comes from the admitted deployment, not the caller spread.
  assert.equal(workflowJob.payload.deploymentId, deployment.id);
  assert.equal(workflowJob.payload.serviceId, service.id);
  assert.equal(workflowJob.payload.projectId, project.id);
  assert.equal(workflowJob.payload.environmentId, dev.id);
  assert.equal(workflowJob.payload.environmentKind, 'dev');
  assert.equal(workflowJob.payload.kind, 'dev');
  assert.equal(workflowJob.environmentId, dev.id);
  assert.equal(workflowJob.operationalProtocolVersion, 2);
  assert.deepEqual(workflowJob.payload.desiredSpecSnapshot, deployment.desiredSpecSnapshot);
  assert.equal(workflowJob.payload.snapshotVersion, deployment.snapshotVersion);
  assert.equal(workflowJob.payload.correlation, 'preserved');
  if (mode === 'immutable-replay') assert.deepEqual(deployment.desiredSpecSnapshot, immutable);
});

// Evaluate only the actual production ID expressions with real helpers. This is
// constructor arithmetic coverage, not a fake Prisma client or native writer test.
function prismaIdentityExpression(method, variable, marker) {
  const source = PrismaControlPlaneRepository.prototype[method].toString();
  const assignments = [...source.matchAll(new RegExp(`const ${variable} = ([^;]+);`, 'gu'))];
  const expression = assignments.find(match => match[1].includes(`'${marker}'`))?.[1]
    ?? (method === 'applyNextPreviewObservation' && variable === 'jobId'
      ? source.match(/id: (stableId\('job', 'github-preview-apply'[^)]*\))/u)?.[1] : null);
  assert.ok(expression, `production ${method}.${variable} constructor must be found`);
  return context => Function('stableId', 'developmentEnvironmentOperationId', ...Object.keys(context), `return (${expression});`)(stableId, developmentEnvironmentOperationId, ...Object.values(context));
}

const prismaIdentityCases = [
  { label: 'push deployment', method: 'handleGitHubWebhook', variable: 'deploymentId', marker: 'github', prefix: 'dep', parts: c => ['github', c.deliveryId, c.service.id, c.actionPlan.kind], variants: c => [{ ...c, service: c.sibling }, { ...c, deliveryId: `${c.deliveryId}-next` }] },
  { label: 'push job', method: 'handleGitHubWebhook', variable: 'workflowJobId', marker: 'github', prefix: 'job', parts: c => ['github', c.deliveryId, c.service.id, c.actionPlan.kind], variants: c => [{ ...c, service: c.sibling }, { ...c, deliveryId: `${c.deliveryId}-next` }] },
  { label: 'PR lineage', method: 'handlePreviewWebhook', variable: 'lineageId', marker: 'preview-lineage', prefix: 'preview-lineage', parts: c => [c.organizationId, c.service.projectId, c.service.id, c.event.installationId, c.event.repositoryId, c.event.pullRequestNumber], variants: c => [{ ...c, service: c.sibling }, { ...c, event: { ...c.event, pullRequestNumber: 8 } }, { ...c, event: { ...c.event, installationId: 'installation-next' } }, { ...c, event: { ...c.event, repositoryId: 'repository-next' } }] },
  { label: 'PR webhook deployment', method: 'handlePreviewWebhook', variable: 'deploymentId', marker: 'github-preview', prefix: 'dep', parts: c => ['github-preview', c.event.deliveryId, c.service.id, c.transition.lineage.generation], variants: c => [{ ...c, service: c.sibling }, { ...c, transition: { lineage: { version: 2, generation: 2 } } }] },
  { label: 'PR webhook job', method: 'handlePreviewWebhook', variable: 'jobId', marker: 'github-preview', prefix: 'job', parts: c => ['github-preview', c.event.deliveryId, c.service.id], variants: c => [{ ...c, service: c.sibling }, { ...c, event: { ...c.event, deliveryId: `${c.event.deliveryId}-next` } }] },
  { label: 'resolver apply deployment', method: 'applyNextPreviewObservation', variable: 'deploymentId', marker: 'github-preview-apply', prefix: 'dep', parts: c => ['github-preview-apply', c.lineage.id, c.transition.lineage.version, c.transition.lineage.generation], variants: c => [{ ...c, lineage: { id: `${c.lineage.id}-sibling` } }, { ...c, transition: { lineage: { version: 2, generation: 1 } } }, { ...c, transition: { lineage: { version: 1, generation: 2 } } }] },
  { label: 'resolver apply job', method: 'applyNextPreviewObservation', variable: 'jobId', marker: 'github-preview-apply', prefix: 'job', parts: c => ['github-preview-apply', c.lineage.id, c.transition.lineage.version], variants: c => [{ ...c, lineage: { id: `${c.lineage.id}-sibling` } }, { ...c, transition: { lineage: { version: 2, generation: 2 } } }] },
];

for (const spec of prismaIdentityCases) test(`round2 Prisma constructor expression retains complete dev tuple: ${spec.label}`, async () => {
  // Given real repository-generated long service/environment identities.
  const { repository, organization, project, dev } = await fixture();
  const service = await repository.createService({ projectId: project.id, environmentId: dev.id, name: 'web', sourceType: 'image', image: 'example/web:v1' });
  const sibling = await repository.createService({ projectId: project.id, environmentId: dev.id, name: 'worker', sourceType: 'image', image: 'example/worker:v1' });
  const context = { environment: dev, service, sibling, organizationId: organization.id, deliveryId: `delivery-${'d'.repeat(55)}`, actionPlan: { kind: 'production-deploy' }, event: { deliveryId: `preview-${'p'.repeat(55)}`, installationId: '77001', repositoryId: '77002', pullRequestNumber: 7 }, transition: { lineage: { version: 1, generation: 1 } }, lineage: { id: developmentEnvironmentOperationId('preview-lineage', dev.id, [organization.id, project.id, service.id, '77001', '77002', 7]) } };
  const construct = prismaIdentityExpression(spec.method, spec.variable, spec.marker);
  // When every late discriminator changes independently, including long-prefix siblings.
  const variants = [context, ...spec.variants(context), { ...context, environment: { ...dev, id: `${dev.id}-other` } }];
  for (const variant of variants) {
    const id = construct(variant);
    assert.equal(id, developmentEnvironmentOperationId(spec.prefix, variant.environment.id, spec.parts(variant)), 'dev constructor must hash the actual complete call tuple');
    assert.equal(construct(variant), id, 'replay must be deterministic');
    assert.ok(id.length <= 63);
    assert.match(id, /^[a-z0-9-]+$/u);
    assert.equal(construct({ ...variant, environment: { ...variant.environment, kind: 'prod' } }), stableId(spec.prefix, ...spec.parts(variant)), 'production constructor must remain byte-for-byte compatible');
  }
  // Then none of those distinct development operations alias one another.
  assert.equal(new Set(variants.map(construct)).size, variants.length);
});
