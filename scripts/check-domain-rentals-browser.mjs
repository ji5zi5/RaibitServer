import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bootRentalRuntime } from '../tests/fixtures/domain-rentals-runtime.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const dashboard = path.join(root, 'apps/dashboard');
const require = createRequire(path.join(dashboard, 'package.json'));
const { chromium, expect } = require('@playwright/test');
const output = process.env.RAIBIT_DOMAIN_EVIDENCE || path.join(os.tmpdir(), 'raibit-domain-browser');
await fs.mkdir(output, { recursive: true });
const privateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'raibit-rental-tls-'));
const report = { cases: [], screenshots: [], passed: false, browserErrors: [] };
let api, next, proxy, browser, page;
let nextLog = '';
const check = async (name, work) => { await work(); report.cases.push({ name, passed: true }); console.log(`PASS ${name}`); };
const port = async () => { const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const value = server.address().port; await new Promise((resolve) => server.close(resolve)); return value; };
try {
  api = await bootRentalRuntime();
  const ordinary = await api.account('browser-ordinary');
  const club = await api.account('browser-club', 'CLUB_MEMBER');
  const nextPort = await port();
  next = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '--hostname', '127.0.0.1', '--port', String(nextPort)], {
    cwd: dashboard, env: { ...process.env, NODE_ENV: 'production', RAIBITSERVER_API_URL: api.baseUrl }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of [next.stdout, next.stderr]) stream.on('data', (chunk) => { nextLog += chunk.toString(); });
  for (let i = 0; ; i++) {
    if (next.exitCode !== null || i >= 120) throw new Error(`Next failed to start: ${nextLog}`);
    try { await fetch(`http://127.0.0.1:${nextPort}/login`, { signal: AbortSignal.timeout(1_000) }); break; }
    catch { await new Promise((resolve) => setTimeout(resolve, 500)); }
  }
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(privateDir, 'key.pem'), '-out', path.join(privateDir, 'cert.pem'), '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  proxy = https.createServer({ key: await fs.readFile(path.join(privateDir, 'key.pem')), cert: await fs.readFile(path.join(privateDir, 'cert.pem')) }, (req, res) => {
    const upstream = http.request({ hostname: '127.0.0.1', port: nextPort, method: req.method, path: req.url,
      headers: { ...req.headers, 'x-forwarded-proto': 'https', 'x-forwarded-host': req.headers.host } }, (response) => {
      res.writeHead(response.statusCode, response.headers); response.pipe(res);
    });
    upstream.on('error', () => { res.writeHead(502); res.end(); }); req.pipe(upstream);
  });
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
  const origin = `https://127.0.0.1:${proxy.address().port}`;
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1200 }, permissions: ['clipboard-read', 'clipboard-write'] });
  page = await context.newPage();
  page.on('pageerror', (error) => report.browserErrors.push(error.message));
  const login = async (account) => {
    await context.clearCookies();
    await context.addCookies([{ name: '__Host-raibitserver_session', value: account.token, url: origin, httpOnly: true, secure: true, sameSite: 'Lax' }]);
    await page.goto(origin + '/account/domains'); await expect(page.locator('[data-domain-rentals]')).toBeVisible();
  };
  const row = (name) => page.locator(`[data-rental-hostname="${name}.raibit.kr"]`);
  const target = 'https://example.org/docs?version=1#intro';
  const create = async (name) => {
    await page.getByLabel('주소 이름', { exact: true }).fill(name);
    await page.getByLabel('연결할 주소', { exact: true }).fill(target);
    await page.getByRole('button', { name: '주소 대여', exact: true }).click();
    await expect(row(name)).toBeVisible(); await expect(page.getByLabel('주소 이름', { exact: true })).toHaveValue('');
  };
  const screenshot = async (name, focus) => {
    // The console has its own scroll container; fullPage captures empty space
    // outside that viewport. Keep real layout/CSS and scroll, without restyling.
    if (focus) await focus.scrollIntoViewIfNeeded();
    else await page.evaluate(() => { for (const element of document.querySelectorAll('*')) if (element.scrollTop) element.scrollTop = 0; window.scrollTo(0, 0); });
    await page.screenshot({ path: path.join(output, name), fullPage: false }); report.screenshots.push(name);
  };
  const selectTheme = async (label, value) => {
    await page.locator('button[aria-label^="테마 설정: 현재"]:visible').click();
    await page.getByRole('menuitemradio', { name: label, exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', value);
  };
  await check('Unauthenticated rental page requires login', async () => {
    await page.goto(origin + '/account/domains'); await expect(page).toHaveURL(/\/login\?/);
  });
  await check('Existing console theme and navigation contain the rental page', async () => {
    await login(ordinary); await expect(page.getByRole('heading', { name: '도메인 대여', exact: true })).toBeVisible();
    assert.ok(await page.locator('a[href="/account/domains"]').count());
  });
  await check('DNS label validation, hyphenated create and full destination persistence', async () => {
    await page.getByLabel('주소 이름', { exact: true }).fill('bad_name');
    assert.equal(await page.getByLabel('주소 이름', { exact: true }).evaluate((node) => node.checkValidity()), false);
    await create('my-project');
    const list = (await api.request(ordinary.token, '/domain-rentals')).body;
    assert.equal(list.rentals[0].targetUrl, target); assert.equal(list.used, 1);
  });
  await check('Rename and destination editing use versioned real server actions', async () => {
    await row('my-project').getByRole('button', { name: '수정', exact: true }).click();
    await page.getByLabel('주소 이름', { exact: true }).fill('my-site');
    await page.getByLabel('연결할 주소', { exact: true }).fill('https://example.org/new?v=2#details');
    await page.getByRole('button', { name: '변경 저장' }).click();
    await expect(row('my-site')).toBeVisible(); await expect(row('my-project')).toHaveCount(0);
    assert.equal((await api.request(ordinary.token, '/domain-rentals')).body.rentals[0].targetUrl, 'https://example.org/new?v=2#details');
  });
  await check('Pause, resume and secure clipboard work', async () => {
    await row('my-site').getByRole('button', { name: '일시 중지', exact: true }).click();
    await expect(row('my-site').getByRole('button', { name: '다시 연결' })).toBeVisible();
    assert.equal((await api.request(ordinary.token, '/domain-rentals')).body.rentals[0].enabled, false);
    await row('my-site').getByRole('button', { name: '다시 연결' }).click();
    await expect(row('my-site').getByRole('button', { name: '일시 중지', exact: true })).toBeVisible();
    await row('my-site').getByRole('button', { name: '주소 복사' }).click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'https://my-site.raibit.kr');
  });
  const longName = 'a'.repeat(63);
  await check('63-character labels and non-club limit of two', async () => {
    await create(longName); await expect(page.getByRole('button', { name: '주소 대여', exact: true })).toBeDisabled();
    assert.equal((await api.request(ordinary.token, '/domain-rentals', { name: 'third-address', targetUrl: target })).status, 409);
    await screenshot('domains-desktop.png');
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await screenshot('domains-mobile.png');
    await screenshot('domains-mobile-editor.png', page.getByLabel('연결할 주소', { exact: true }));
    await screenshot('domains-mobile-addresses.png', row(longName));
    const box = await row(longName).boundingBox(); assert.ok(box && box.x >= 0 && box.x + box.width <= 390);
  });
  await check('Built-in theme menu applies and persists dark and light modes', async () => {
    // Use the application's data-theme menu and cookie, not a synthetic .dark
    // class: otherwise existing components and custom tokens can disagree.
    await selectTheme('다크', 'dark');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(row(longName)).toBeVisible();
    await screenshot('domains-mobile-dark.png');
    await screenshot('domains-mobile-dark-addresses.png', row(longName));
    await selectTheme('라이트', 'light');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.setViewportSize({ width: 1440, height: 1200 });
  });
  await check('Stale edits block further writes until explicit refresh', async () => {
    await row('my-site').getByRole('button', { name: '수정', exact: true }).click();
    const current = (await api.request(ordinary.token, '/domain-rentals')).body.rentals.find((r) => r.name === 'my-site');
    assert.equal((await api.request(ordinary.token, `/domain-rentals/${current.id}/update`, { expectedVersion: current.version, targetUrl: 'https://example.org/newest' })).status, 200);
    await page.getByRole('button', { name: '변경 저장' }).click();
    await expect(page.locator('[data-domain-rentals]').getByRole('alert')).toContainText('다른 화면에서 변경');
    await expect(page.getByRole('button', { name: '변경 저장' })).toBeDisabled();
    await page.getByRole('button', { name: '목록 새로고침' }).click();
    await expect(row('my-site')).toContainText('https://example.org/newest');
  });
  await check('Delete confirmation can be cancelled and frees one quota slot', async () => {
    await row(longName).getByRole('button', { name: '삭제', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await screenshot('domains-delete-confirmation.png', page.getByRole('dialog'));
    await page.getByRole('dialog').getByRole('button', { name: '취소', exact: true }).click();
    await expect(row(longName)).toBeVisible();
    assert.equal((await api.request(ordinary.token, '/domain-rentals')).body.used, 2);
    await row(longName).getByRole('button', { name: '삭제', exact: true }).click();
    await page.getByRole('button', { name: '삭제 확인' }).click();
    await expect(row(longName)).toHaveCount(0);
    await expect(page.getByRole('button', { name: '주소 대여', exact: true })).toBeEnabled();
    assert.equal((await api.request(ordinary.token, '/domain-rentals')).body.remaining, 1);
  });
  await check('Club member may rent five, but not six', async () => {
    await login(club);
    for (let i = 1; i <= 5; i++) await create(`club-project-${i}`);
    await expect(page.getByRole('button', { name: '주소 대여', exact: true })).toBeDisabled();
    assert.equal((await api.request(club.token, '/domain-rentals', { name: 'club-project-6', targetUrl: target })).status, 409);
    await screenshot('domains-club.png');
  });
  assert.deepEqual(report.browserErrors, []); report.passed = true;
} catch (error) {
  report.failure = error.stack; process.exitCode = 1; console.error(error);
  if (page && !page.isClosed()) { try { await page.screenshot({ path: path.join(output, 'failure.png') }); } catch {} }
} finally {
  await fs.writeFile(path.join(output, 'browser-report.json'), JSON.stringify(report, null, 2));
  await fs.writeFile(path.join(output, 'next.log'), nextLog);
  if (browser) await browser.close();
  if (proxy) { proxy.closeAllConnections(); await new Promise((resolve) => proxy.close(resolve)); }
  if (next && next.exitCode === null) { next.kill('SIGTERM'); await once(next, 'exit'); }
  if (api) await api.close();
  await fs.rm(privateDir, { recursive: true, force: true });
}
