// Запуск: npm test (env-переменные подставлены ниже, БД не нужна)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

const BOT_TOKEN = '1234567890:TEST_TOKEN_aaaaaaaaaaaaaaaaaaaaaaaa';
Object.assign(process.env, {
  BOT_TOKEN, PUBLIC_URL: 'https://api.test', WEBAPP_URL: 'https://app.test', DATABASE_URL: 'postgres://x',
  BOT_USERNAME: 'test_bot', BOT_WEBHOOK_SECRET: 'x'.repeat(16), HH_USER_AGENT: 'test',
  PLATEGA_MERCHANT_ID: '1a021d91-9b26-4762-b303-5d4aac74e921', PLATEGA_SECRET: 'secret123',
});
const { validateInitData } = await import('./telegramAuth.js');

function sign(fields: Record<string, string>) {
  const dcs = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const hash = createHmac('sha256', secret).update(dcs).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}

const now = Math.floor(Date.now() / 1000);
const user = JSON.stringify({ id: 42, first_name: 'Test' });

test('валидная подпись', () => {
  const r = validateInitData(sign({ auth_date: String(now), user, query_id: 'q1', start_param: 'search' }));
  assert.equal(r.user.id, 42);
  assert.equal(r.startParam, 'search');
});

test('подмена поля ломает подпись', () => {
  const raw = sign({ auth_date: String(now), user }).replace('%22id%22%3A42', '%22id%22%3A43');
  assert.throws(() => validateInitData(raw), { code: 'AUTH_INVALID' });
});

test('просроченный auth_date', () => {
  assert.throws(() => validateInitData(sign({ auth_date: String(now - 90000), user })), { code: 'AUTH_EXPIRED' });
});

test('без hash', () => {
  assert.throws(() => validateInitData(`auth_date=${now}&user=${encodeURIComponent(user)}`), { code: 'AUTH_INVALID' });
});
