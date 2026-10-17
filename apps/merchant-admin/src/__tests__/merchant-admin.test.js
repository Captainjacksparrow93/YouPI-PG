import '../../../../scripts/test-env.js';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Database } from '@youpi/db';
import { startAdminServer } from '../index.js';

describe('Merchant Admin Integration Tests', () => {
  let serverInstance;
  let baseUrl;
  let testDb;

  before(async () => {
    testDb = new Database({ inMemory: true });
    serverInstance = await startAdminServer(6101, { db: testDb });
    baseUrl = `http://localhost:${serverInstance.port}`;
  });

  after(async () => {
    await serverInstance.close();
    testDb.close();
  });

  let sessionCookie = '';

  function send(path, { method = 'GET', body = null, headers = {} } = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request(`${baseUrl}${path}`, {
        method,
        headers: { ...(sessionCookie ? { cookie: sessionCookie } : {}), ...headers }
      }, res => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          resolve({ status: res.statusCode, headers: res.headers, text: data });
        });
      });
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  }

  const get = path => send(path);

  function login(password) {
    return send('/login', {
      method: 'POST',
      body: `password=${encodeURIComponent(password)}`,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });
  }

  test('Dashboard and admin APIs require login', async () => {
    const page = await get('/');
    assert.equal(page.status, 303);
    assert.equal(page.headers.location, '/login');

    const api = await get('/api/v1/admin/upi-accounts');
    assert.equal(api.status, 401);
  });

  test('Wrong password is rejected; correct password issues an HttpOnly session cookie', async () => {
    const bad = await login('not-the-password');
    assert.equal(bad.status, 401);
    assert.equal(bad.headers['set-cookie'], undefined);

    const good = await login(process.env.YOUPI_ADMIN_PASSWORD);
    assert.equal(good.status, 303);
    const cookie = good.headers['set-cookie'][0];
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    sessionCookie = cookie.split(';')[0];
  });

  test('Forged session cookie is rejected', async () => {
    const saved = sessionCookie;
    sessionCookie = `youpi_admin=${Date.now() + 100000}.deadbeef`;
    const res = await get('/');
    assert.equal(res.status, 303);
    sessionCookie = saved;
  });

  test('GET /health returns UP', async () => {
    const res = await get('/health');
    assert.equal(res.status, 200);
    const json = JSON.parse(res.text);
    assert.equal(json.status, 'UP');
    assert.equal(json.service, 'merchant-admin');
  });

  test('GET / renders dashboard with queue monitor, observers, counter desk & pairing modal', async () => {
    const res = await get('/');
    assert.equal(res.status, 200);
    assert.ok(res.headers['content-type'].includes('text/html'));

    assert.ok(res.text.includes('Real-Time Receiving Account Slot Ownership'));
    assert.ok(res.text.includes('Active Slot (5-Minute Window)'));
    assert.ok(res.text.includes('Processing Slot (30s Verification Window)'));
    assert.ok(res.text.includes('Live Counter Payment Requests'));
    assert.ok(res.text.includes('Payment Observers (SMS & Gmail)'));
    assert.ok(res.text.includes('Android SMS Gateway'));
    assert.ok(res.text.includes('Gmail Direct API'));
  });

  test('GET /api/admin/tickets returns tickets array', async () => {
    const res = await get('/api/admin/tickets');
    assert.equal(res.status, 200);
    const json = JSON.parse(res.text);
    assert.ok(Array.isArray(json));
  });
});
