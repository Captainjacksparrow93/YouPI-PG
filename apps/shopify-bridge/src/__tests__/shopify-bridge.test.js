import '../../../../scripts/test-env.js';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Database } from '@youpi/db';
import { startServer as startPaymentApi } from '../../../payment-api/src/index.js';
import { startShopifyBridge } from '../index.js';
import { BridgeStore } from '../store.js';
import { verifySessionToken, moneyToPaise, verifyOAuthQuery } from '../shopify.js';
import { TEST_ADMIN_TOKEN, TEST_SERVICE_TOKEN, TEST_MERCHANT_SECRET_KEY } from '../../../../scripts/test-env.js';

const SHOP = 'youpi-test.myshopify.com';
const API_KEY = 'test_shopify_api_key';
const API_SECRET = 'test_shopify_api_secret';
const YOUPI_WEBHOOK_SECRET = 'test_youpi_webhook_secret';
const RECEIVING_ACCOUNT_ID = '00000000-0000-0000-0000-000000000002';

/** In-memory stand-in for the Shopify Admin GraphQL API. */
function createMockShopify() {
  const orders = new Map();
  const calls = [];

  async function handle(body) {
    const { query, variables } = body;
    calls.push({ query, variables });
    if (query.includes('query YoupiOrder')) {
      const id = variables.id.split('/').pop();
      return { data: { order: orders.get(id) || null } };
    }
    if (query.includes('orderMarkAsPaid')) {
      const id = variables.input.id.split('/').pop();
      const order = orders.get(id);
      order.displayFinancialStatus = 'PAID';
      order.totalOutstandingSet.shopMoney.amount = '0.00';
      return { data: { orderMarkAsPaid: { order: { id: variables.input.id, displayFinancialStatus: 'PAID' }, userErrors: [] } } };
    }
    if (query.includes('mutation YoupiRecord')) {
      return { data: { tagsAdd: { userErrors: [] }, metafieldsSet: { userErrors: [] } } };
    }
    if (query.includes('mutation YoupiPayUrl')) {
      return { data: { metafieldsSet: { userErrors: [] } } };
    }
    return { errors: [{ message: 'unexpected query' }] };
  }

  return {
    orders,
    calls,
    addOrder(id, amount, { gateway = 'UPI (YouPI)', currency = 'INR' } = {}) {
      orders.set(String(id), {
        id: `gid://shopify/Order/${id}`,
        name: `#${id}`,
        email: `buyer${id}@example.com`,
        phone: null,
        cancelledAt: null,
        displayFinancialStatus: 'PENDING',
        paymentGatewayNames: [gateway],
        totalOutstandingSet: { shopMoney: { amount, currencyCode: currency } },
        customer: { firstName: 'Test', lastName: 'Buyer' }
      });
    },
    fetchImpl(url, init) {
      const target = String(url);
      if (target.startsWith(`https://${SHOP}/admin/api/`)) {
        assert.equal(init.headers['X-Shopify-Access-Token'], 'shpat_test');
        return handle(JSON.parse(init.body)).then(json => new Response(JSON.stringify(json), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      return fetch(url, init);
    }
  };
}

function signJwt(payload, secret = API_SECRET) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

async function waitFor(predicate, timeoutMs = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error('Timed out waiting for condition');
}

describe('Shopify bridge end-to-end with YOUPI payment API', () => {
  let testDb;
  let api;
  let bridge;
  let apiUrl;
  let bridgeUrl;
  let shopify;

  before(async () => {
    testDb = new Database({ inMemory: true });
    api = await startPaymentApi(6196, testDb);
    apiUrl = `http://localhost:${api.port}`;
    shopify = createMockShopify();

    bridge = await startShopifyBridge({
      port: 0,
      store: new BridgeStore(null),
      fetchImpl: shopify.fetchImpl,
      logger: { log() {}, warn() {}, error() {} },
      config: {
        shopDomain: SHOP,
        apiKey: API_KEY,
        apiSecret: API_SECRET,
        adminAccessToken: 'shpat_test',
        appUrl: 'https://bridge.example.com',
        youpiApiUrl: apiUrl,
        youpiSecretKey: TEST_MERCHANT_SECRET_KEY,
        youpiWebhookSecret: YOUPI_WEBHOOK_SECRET,
        paymentMethodName: 'UPI (YouPI)'
      }
    });
    bridgeUrl = `http://localhost:${bridge.port}`;

    const settings = await fetch(`${apiUrl}/api/v1/admin/merchant-settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
      body: JSON.stringify({ webhookUrl: `${bridgeUrl}/youpi/webhook`, webhookSecret: YOUPI_WEBHOOK_SECRET })
    });
    assert.equal(settings.status, 200);
  });

  after(async () => {
    await bridge.close();
    await api.close();
    testDb.close();
  });

  function shopifyWebhook(path, payload, { secret = API_SECRET, shop = SHOP } = {}) {
    const raw = JSON.stringify(payload);
    const hmac = crypto.createHmac('sha256', secret).update(raw).digest('base64');
    return fetch(`${bridgeUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Hmac-Sha256': hmac,
        'X-Shopify-Shop-Domain': shop,
        'X-Shopify-Webhook-Id': crypto.randomUUID(),
        'x-test-anonymous': '1'
      },
      body: raw
    });
  }

  function activate(paymentId) {
    const { queueEngine, timingEngine } = api.app.context;
    const result = queueEngine.enqueueOrActivate(paymentId, RECEIVING_ACCOUNT_ID);
    if (result.expiresAt) timingEngine.startActiveTimer(paymentId, result.expiresAt);
    return result;
  }

  function resetSlot() {
    testDb.execute("UPDATE payment_sessions SET status = 'CANCELLED' WHERE status IN ('ACTIVE', 'PROCESSING', 'QUEUED')");
    testDb.execute('UPDATE payment_receiving_accounts SET is_slot_busy = 0, current_active_session_id = NULL');
  }

  async function bankObservation(amount, utr) {
    const res = await fetch(`${apiUrl}/api/v1/pollers/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TEST_SERVICE_TOKEN}` },
      body: JSON.stringify({ source: 'GOOGLE_MESSAGES', receivingAccountId: RECEIVING_ACCOUNT_ID, amount, utr, observedAt: new Date().toISOString() })
    });
    assert.equal(res.status, 200);
    return res.json();
  }

  test('orders/create creates a YOUPI payment for the Shopify amount, and a verified payment marks the order paid with its UTR', async () => {
    resetSlot();
    shopify.addOrder('1001', '499.00');

    const hook = await shopifyWebhook('/shopify/webhooks/orders-create', { id: 1001, payment_gateway_names: ['UPI (YouPI)'] });
    assert.equal(hook.status, 200);

    const link = await waitFor(() => bridge.store.getOrder('1001'));
    assert.equal(link.amountPaise, 49900);
    assert.equal(link.youpiOrderId, 'SHOPIFY-1001');
    assert.ok(shopify.calls.some(c => c.query.includes('mutation YoupiPayUrl')), 'pay link saved to order metafield');

    const youpiPayment = await (await fetch(`${apiUrl}/api/v1/payments/${link.paymentId}`)).json();
    assert.equal(youpiPayment.amount, '499.00');
    assert.equal(youpiPayment.metadata.shopify_order_id, '1001');

    activate(link.paymentId);
    const obs = await bankObservation('499.00', '412345678901');
    assert.equal(obs.attribution.attributed, true);

    await waitFor(() => bridge.store.getOrder('1001').status === 'PAID');
    const markPaid = shopify.calls.find(c => c.query.includes('orderMarkAsPaid'));
    assert.equal(markPaid.variables.input.id, 'gid://shopify/Order/1001');
    const record = shopify.calls.find(c => c.query.includes('mutation YoupiRecord'));
    assert.equal(record.variables.metafields.find(m => m.key === 'utr').value, '412345678901');
    assert.equal(bridge.store.getOrder('1001').utr, '412345678901');
  });

  test('Orders paid with another method are ignored', async () => {
    shopify.addOrder('1002', '100.00', { gateway: 'Cash on Delivery (COD)' });
    await shopifyWebhook('/shopify/webhooks/orders-create', { id: 1002, payment_gateway_names: ['Cash on Delivery (COD)'] });
    await new Promise(r => setTimeout(r, 200));
    assert.equal(bridge.store.getOrder('1002'), null);
  });

  test('Forged Shopify and YOUPI webhooks are rejected', async () => {
    const badShopify = await shopifyWebhook('/shopify/webhooks/orders-create', { id: 1003, payment_gateway_names: ['UPI (YouPI)'] }, { secret: 'wrong' });
    assert.equal(badShopify.status, 401);

    const otherShop = await shopifyWebhook('/shopify/webhooks/orders-create', { id: 1003 }, { shop: 'evil.myshopify.com' });
    assert.equal(otherShop.status, 403);

    const forged = JSON.stringify({ event: 'SUCCESS', paymentId: 'x', amountPaise: 1, currency: 'INR', metadata: { shopify_order_id: '1001' } });
    const badYoupi = await fetch(`${bridgeUrl}/youpi/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Gateway-Signature': 'sha256=' + 'a'.repeat(64), 'x-test-anonymous': '1' },
      body: forged
    });
    assert.equal(badYoupi.status, 401);
  });

  test('A correctly signed SUCCESS for the wrong amount is flagged, not marked paid', async () => {
    shopify.addOrder('1004', '250.00');
    bridge.store.upsertOrder('1004', { paymentId: 'p-1004', amountPaise: 25000, status: 'PENDING' });
    const before = shopify.calls.filter(c => c.query.includes('orderMarkAsPaid')).length;

    const raw = JSON.stringify({ event: 'SUCCESS', paymentId: 'p-1004', amountPaise: 100, currency: 'INR', metadata: { shopify_order_id: '1004' } });
    const sig = 'sha256=' + crypto.createHmac('sha256', YOUPI_WEBHOOK_SECRET).update(raw).digest('hex');
    const res = await fetch(`${bridgeUrl}/youpi/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Gateway-Signature': sig, 'X-Gateway-Delivery-Id': crypto.randomUUID() },
      body: raw
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).flagged, 'AMOUNT_MISMATCH');
    assert.equal(bridge.store.getOrder('1004').status, 'NEEDS_REVIEW');
    assert.equal(shopify.calls.filter(c => c.query.includes('orderMarkAsPaid')).length, before);
  });

  test('Thank-you extension endpoint needs a valid session token and returns a checkout URL', async () => {
    resetSlot();
    shopify.addOrder('1005', '75.50');
    const now = Math.floor(Date.now() / 1000);

    const noToken = await fetch(`${bridgeUrl}/api/extension/payment`, { method: 'POST', headers: { 'x-test-anonymous': '1' }, body: JSON.stringify({ orderId: 'gid://shopify/OrderIdentity/1005' }) });
    assert.equal(noToken.status, 401);

    const wrongShop = signJwt({ dest: 'https://evil.myshopify.com', aud: API_KEY, exp: now + 60, nbf: now - 5 });
    const rejected = await fetch(`${bridgeUrl}/api/extension/payment`, {
      method: 'POST', headers: { Authorization: `Bearer ${wrongShop}` }, body: JSON.stringify({ orderId: 'gid://shopify/OrderIdentity/1005' })
    });
    assert.equal(rejected.status, 401);

    const token = signJwt({ dest: `https://${SHOP}`, aud: API_KEY, exp: now + 60, nbf: now - 5 });
    const ok = await fetch(`${bridgeUrl}/api/extension/payment`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ orderId: 'gid://shopify/OrderIdentity/1005' })
    });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.state, 'PAY');
    assert.equal(body.amount, '75.50');
    assert.match(body.checkoutUrl, /\/checkout\//);

    // Calling again reuses the open session instead of creating a second one.
    const again = await (await fetch(`${bridgeUrl}/api/extension/payment`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ orderId: 'gid://shopify/OrderIdentity/1005' })
    })).json();
    assert.equal(again.paymentId, body.paymentId);
  });

  test('Signed pay link redirects to checkout; tampered link is refused', async () => {
    shopify.addOrder('1006', '10.00');
    const link = bridge.bridge.payLink('1006').replace('https://bridge.example.com', bridgeUrl);
    const res = await fetch(link, { redirect: 'manual' });
    assert.equal(res.status, 303);
    assert.match(res.headers.get('location'), /\/checkout\//);

    const tampered = await fetch(link.replace('/pay/1006', '/pay/1001'), { redirect: 'manual' });
    assert.equal(tampered.status, 403);
  });
});

describe('Shopify helpers', () => {
  test('moneyToPaise is exact', () => {
    assert.equal(moneyToPaise('499.00'), 49900);
    assert.equal(moneyToPaise('0.1'), 10);
    assert.equal(moneyToPaise('1234.56'), 123456);
    assert.throws(() => moneyToPaise('-1'));
  });

  test('Expired session tokens are rejected', () => {
    const now = Math.floor(Date.now() / 1000);
    const token = signJwt({ dest: `https://${SHOP}`, aud: API_KEY, exp: now - 120 });
    assert.equal(verifySessionToken(token, { apiKey: API_KEY, apiSecret: API_SECRET, shopDomain: SHOP }), null);
  });

  test('OAuth query HMAC verification', () => {
    const params = new URLSearchParams({ code: 'abc', shop: SHOP, state: 's1', timestamp: '1700000000' });
    const message = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('&');
    params.set('hmac', crypto.createHmac('sha256', API_SECRET).update(message).digest('hex'));
    assert.equal(verifyOAuthQuery(params, API_SECRET), true);
    params.set('shop', 'evil.myshopify.com');
    assert.equal(verifyOAuthQuery(params, API_SECRET), false);
  });
});
