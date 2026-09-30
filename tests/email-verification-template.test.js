import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { buildEmailVerificationMessage, deliverEmailVerificationMessage } from '../packages/core/src/email-verification.ts';

test('verification email includes a branded HTML body and a plain-text alternative', () => {
  const message = buildEmailVerificationMessage({
    email: 'member@example.com',
    code: '123456',
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    env: { RAIBITSERVER_EMAIL_DOMAIN: 'raibitserver.app' },
  });

  assert.equal(message.subject, 'RAIBITSERVER 이메일 인증 코드');
  assert.match(message.text, /회원가입 인증 코드: 123456/);
  assert.match(message.html, /<html lang="ko">/);
  assert.match(message.html, /RAIBITSERVER/);
  assert.match(message.html, /이메일 인증을 완료해 주세요/);
  assert.match(message.html, /font-size:36px[^>]*>123456<\/p>/);
  assert.match(message.html, /약 <strong>10분<\/strong> 후 만료됩니다/);
  assert.match(message.html, /Incheon Science High School · RAIBIT/);
  assert.match(message.html, /href="https:\/\/raibit\.kr"/);
  assert.match(message.html, /href="mailto:ishsraibit@gmail\.com"/);
  assert.match(message.text, /Incheon Science High School · RAIBIT/);
  assert.match(message.text, /사이트: https:\/\/raibit\.kr/);
  assert.match(message.text, /문의 이메일: ishsraibit@gmail\.com/);
  assert.doesNotMatch(message.html, /<img\b/);
});

test('verification email escapes dynamic content in HTML', () => {
  const message = buildEmailVerificationMessage({
    email: 'member@example.com',
    code: '12<456',
    appName: 'RAIBIT <Team> & Co',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    env: { RAIBITSERVER_EMAIL_DOMAIN: 'raibitserver.app' },
  });

  assert.match(message.html, /RAIBIT &lt;Team&gt; &amp; Co/);
  assert.match(message.html, /12&lt;456/);
  assert.doesNotMatch(message.html, /<Team>|12<456/);
});

test('webhook receives both HTML and plain-text email bodies', async () => {
  let received;
  const server = http.createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    received = JSON.parse(body);
    response.writeHead(202, { 'x-message-id': 'mail-preview-1' });
    response.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const message = buildEmailVerificationMessage({
      email: 'member@example.com',
      code: '654321',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      env: { RAIBITSERVER_EMAIL_DOMAIN: 'raibitserver.app' },
    });
    const delivery = await deliverEmailVerificationMessage(message, {
      RAIBITSERVER_EMAIL_FROM: message.from,
      RAIBITSERVER_EMAIL_WEBHOOK_URL: `http://127.0.0.1:${server.address().port}/send`,
      RAIBITSERVER_EMAIL_DELIVERY_MODE: 'webhook',
    });

    assert.equal(delivery.messageId, 'mail-preview-1');
    assert.equal(received.to, message.to);
    assert.equal(received.text, message.text);
    assert.equal(received.html, message.html);
  } finally {
    server.close();
    await once(server, 'close');
  }
});
