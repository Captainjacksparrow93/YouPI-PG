import '../../../../scripts/test-env.js';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Database } from '@youpi/db';
import { startServer } from '../index.js';
import { TEST_ADMIN_TOKEN, TEST_SERVICE_TOKEN, TEST_MERCHANT_SECRET_KEY } from '../../../../scripts/test-env.js';

const RECEIVING_ACCOUNT_ID = '00000000-0000-0000-0000-000000000002';

describe('Security hardening: reproduced attacks are blocked', () => {
  let serverInstance;
  let baseUrl;
  let testDb;

  before(async () => {
    testDb = new Database({ inMemory: true });
    serverInstance = await startServer(6197, testDb);
    baseUrl = `http://localhost:${serverInstance.port}`;
  });

  after(async () => {
    process.env.YOUPI_ENABLE_DEV_TOOLS = 'true';
    await serverInstance.close();
    testDb.close();
  });

  /** Sends a request WITHOUT the test-suite admin token unless headers supply credentials. */
  function request(path, { method = 'GET', body, headers = {} } = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request(new URL(path, baseUrl), {
        method,
        headers: { 'Content-Type': 'application/json', 'x-test-anonymous': '1', ...headers }
      }, res => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          let parsed;
          try { parsed = JSON.parse(data); } catch { parsed = data; }
          resolve({ status: res.statusCode, body: parsed });
        });
      });
      req.on('error', reject);
      if (body !== undefined) req.write(JSON.stringify(body));
      req.end();
    });
  }

  const merchantAuth = { Authorization: `Bearer ${TEST_MERCHANT_SECRET_KEY}` };
  const adminAuth = { Authorization: `Bearer ${TEST_ADMIN_TOKEN}` };

  async function createPayment(orderId, amount = '499.00', extra = {}) {
    const res = await request('/api/v1/payments', {
      method: 'POST',
      headers: merchantAuth,
      body: { orderId, amount, autoActivate: true, ...extra }
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body;
  }

  test('Fake SMS via /checkout/:id/simulate-observation cannot mark a session paid', async () => {
    const payment = await createPayment('SEC-FAKE-SMS-1');
    const fakeSms = {
      source: 'SMS',
      sender: 'VM-HDFCBK',
      rawText: 'Rs.499.00 credited to a/c XX1234 on 17-10-26 by VPA payer@okaxis (UPI Ref No 123456789012). -HDFC Bank'
    };

    process.env.YOUPI_ENABLE_DEV_TOOLS = 'false';
    const disabled = await request(`/api/v1/checkout/${payment.paymentId}/simulate-observation`, { method: 'POST', body: fakeSms });
    assert.equal(disabled.status, 404);

    process.env.YOUPI_ENABLE_DEV_TOOLS = 'true';
    const anonymous = await request(`/api/v1/checkout/${payment.paymentId}/simulate-observation`, { method: 'POST', body: fakeSms });
    assert.equal(anonymous.status, 401);

    const state = await request(`/api/v1/payments/${payment.paymentId}`);
    assert.notEqual(state.body.status, 'SUCCESS');
  });

  test('Fake observation via /pollers/events requires the observer service token', async () => {
    const payment = await createPayment('SEC-FAKE-OBS-1', '321.00');
    const forged = {
      source: 'GOOGLE_MESSAGES',
      receivingAccountId: RECEIVING_ACCOUNT_ID,
      amount: '321.00',
      utr: '999999999999'
    };

    const anonymous = await request('/api/v1/pollers/events', { method: 'POST', body: forged });
    assert.equal(anonymous.status, 401);

    const customerToken = await request('/api/v1/pollers/events', {
      method: 'POST', body: forged, headers: { Authorization: 'Bearer some-customer-session-token' }
    });
    assert.equal(customerToken.status, 401);

    const state = await request(`/api/v1/payments/${payment.paymentId}`);
    assert.notEqual(state.body.status, 'SUCCESS');

    const service = await request('/api/v1/pollers/active-window', { headers: { Authorization: `Bearer ${TEST_SERVICE_TOKEN}` } });
    assert.equal(service.status, 200);
  });

  test('Admin API rejects unauthenticated VPA, webhook and key changes', async () => {
    const addVpa = await request('/api/v1/admin/upi-accounts', {
      method: 'POST', body: { upiId: 'attacker@okhdfc', payeeName: 'Attacker', activate: true }
    });
    assert.equal(addVpa.status, 401);

    const webhook = await request('/api/v1/admin/merchant-settings', {
      method: 'POST', body: { webhookUrl: 'https://attacker.example/hook', webhookSecret: 'x' }
    });
    assert.equal(webhook.status, 401);

    const gmailSecrets = await request('/api/v1/admin/gmail/credentials');
    assert.equal(gmailSecrets.status, 401);

    const merchantKeyIsNotAdmin = await request('/api/v1/admin/upi-accounts', { headers: merchantAuth });
    assert.equal(merchantKeyIsNotAdmin.status, 401);

    const accounts = await request('/api/v1/admin/upi-accounts', { headers: adminAuth });
    assert.equal(accounts.status, 200);
    assert.ok(!JSON.stringify(accounts.body).includes('attacker@okhdfc'));
  });

  test('Creating payments requires the merchant secret key; rotated keys work and old ones do not', async () => {
    const anonymous = await request('/api/v1/payments', { method: 'POST', body: { orderId: 'SEC-ANON-1', amount: '1.00' } });
    assert.equal(anonymous.status, 401);

    const spoofedHeader = await request('/api/v1/payments', {
      method: 'POST',
      headers: { 'X-Merchant-Id': '00000000-0000-0000-0000-000000000001' },
      body: { orderId: 'SEC-ANON-2', amount: '1.00' }
    });
    assert.equal(spoofedHeader.status, 401);

    const rotated = await request('/api/v1/admin/api-keys/rotate', { method: 'POST', headers: adminAuth, body: {} });
    assert.equal(rotated.status, 201);
    assert.match(rotated.body.secretKey, /^sk_live_/);

    const withRotated = await request('/api/v1/payments', {
      method: 'POST',
      headers: { Authorization: `Bearer ${rotated.body.secretKey}` },
      body: { orderId: 'SEC-ROTATED-1', amount: '10.00' }
    });
    assert.equal(withRotated.status, 201);

    const wrongKey = await request('/api/v1/payments', {
      method: 'POST',
      headers: { Authorization: 'Bearer sk_live_not_a_real_key' },
      body: { orderId: 'SEC-WRONG-1', amount: '10.00' }
    });
    assert.equal(wrongKey.status, 401);

    const orderLookup = await request('/api/v1/orders/SEC-ROTATED-1/cod');
    assert.equal(orderLookup.status, 401);
  });

  test('Retried orders keep the merchant order ID in merchantOrderId', async () => {
    const first = await createPayment('SEC-RETRY-1', '50.00', { metadata: { shopify_order_id: '555' } });
    await request(`/api/v1/checkout/${first.paymentId}/cancel`, { method: 'POST', body: {} });

    const retry = await createPayment('SEC-RETRY-1', '50.00', { metadata: { shopify_order_id: '555' } });
    assert.notEqual(retry.paymentId, first.paymentId);
    assert.match(retry.orderId, /^SEC-RETRY-1-R\d{4}$/);
    assert.equal(retry.merchantOrderId, 'SEC-RETRY-1');

    const status = await request(`/api/v1/payments/${retry.paymentId}`);
    assert.equal(status.body.merchantOrderId, 'SEC-RETRY-1');
    assert.equal(status.body.metadata.shopify_order_id, '555');
  });

  test('Android pairing rejects the old hardcoded tokens and unsigned SMS observations', async () => {
    for (const token of ['youpi_sms_pair_token_secure', 'pair_00000000', 'android_pairing_enrollment_secret_key_32_chars']) {
      const res = await request('/api/v1/pollers/android/pair', { method: 'POST', body: { enrollmentToken: token } });
      assert.equal(res.status, 401, `token ${token} must be rejected`);
    }

    const paired = await request('/api/v1/pollers/android/pair', {
      method: 'POST', body: { enrollmentToken: process.env.ANDROID_ENROLLMENT_SECRET }
    });
    assert.equal(paired.status, 200);

    const unsigned = await request('/api/v1/pollers/android/events', {
      method: 'POST',
      headers: { 'X-Device-Id': paired.body.deviceId },
      body: { sender: 'VM-HDFCBK', body: 'Rs.499.00 credited to a/c XX1234 UPI Ref No 123456789012' }
    });
    assert.equal(unsigned.status, 401);
  });
});
