import http from 'node:http';
import crypto from 'node:crypto';
import { ShopifyYoupiBridge } from './bridge.js';
import {
  verifyShopifyWebhook,
  verifyOAuthQuery,
  verifySessionToken,
  isValidShopDomain,
  numericOrderId,
  exchangeOAuthCode,
  ShopifyAdminClient
} from './shopify.js';

const MAX_BODY_BYTES = 1024 * 1024;

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Payload Too Large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, status, data, extraHeaders = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...extraHeaders });
  res.end(JSON.stringify(data));
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function sendMessagePage(res, status, title, message) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:480px;margin:15vh auto;padding:0 16px;color:#1f2937}h1{font-size:1.3rem}</style></head>
<body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></body></html>`);
}

// Checkout / customer-account UI extensions run on Shopify's CDN origin and authenticate with a session token.
const EXTENSION_CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type'
};

export class ShopifyBridgeServer {
  /**
   * @param {{
   *   config: ReturnType<typeof import('./config.js').loadBridgeConfig>,
   *   store: import('./store.js').BridgeStore,
   *   fetchImpl?: typeof fetch,
   *   logger?: Pick<Console, 'log' | 'warn' | 'error'>
   * }} options
   */
  constructor({ config, store, fetchImpl, logger }) {
    this.config = config;
    this.store = store;
    this.fetch = fetchImpl || fetch;
    this.log = logger || console;
    this.bridge = new ShopifyYoupiBridge({ config, store, fetchImpl: this.fetch, logger: this.log });
    this.oauthStates = new Map(); // state -> expiresAt
    this.recentShopifyWebhookIds = new Set();
  }

  createServer() {
    return http.createServer((req, res) => {
      this.route(req, res).catch(err => {
        this.log.error(`[Shopify Bridge] ${req.method} ${req.url} failed:`, err.message);
        if (!res.headersSent) sendJson(res, 500, { error: 'Internal error' });
      });
    });
  }

  async route(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const { pathname } = url;
    const method = req.method.toUpperCase();

    if (pathname === '/health') {
      sendJson(res, 200, { status: 'UP', service: 'shopify-bridge', shop: this.config.shopDomain, connected: Boolean(this.config.adminAccessToken || this.store.getShopToken(this.config.shopDomain)) });
      return;
    }

    if (pathname === '/shopify/install' && method === 'GET') return this.handleInstall(res);
    if (pathname === '/shopify/callback' && method === 'GET') return this.handleOAuthCallback(url, res);
    if (pathname === '/shopify/webhooks/orders-create' && method === 'POST') return this.handleShopifyWebhook(req, res, 'orders/create');
    if (pathname === '/shopify/webhooks/app-uninstalled' && method === 'POST') return this.handleShopifyWebhook(req, res, 'app/uninstalled');
    if (pathname === '/youpi/webhook' && method === 'POST') return this.handleYoupiWebhook(req, res);

    if (pathname === '/api/extension/payment') {
      if (method === 'OPTIONS') {
        res.writeHead(204, EXTENSION_CORS);
        res.end();
        return;
      }
      if (method === 'POST') return this.handleExtensionPayment(req, res);
    }

    const payMatch = /^\/pay\/(\d+)$/.exec(pathname);
    if (payMatch && method === 'GET') return this.handlePayLink(payMatch[1], url.searchParams.get('sig'), res);

    sendJson(res, 404, { error: 'Not found' });
  }

  handleInstall(res) {
    if (!isValidShopDomain(this.config.shopDomain) || !this.config.apiKey) {
      sendMessagePage(res, 500, 'Bridge not configured', 'Set SHOPIFY_SHOP_DOMAIN (your-store.myshopify.com), SHOPIFY_API_KEY and SHOPIFY_API_SECRET first.');
      return;
    }
    const state = crypto.randomBytes(16).toString('hex');
    this.oauthStates.set(state, Date.now() + 10 * 60 * 1000);
    const authorizeUrl = new URL(`https://${this.config.shopDomain}/admin/oauth/authorize`);
    authorizeUrl.searchParams.set('client_id', this.config.apiKey);
    authorizeUrl.searchParams.set('scope', this.config.scopes);
    authorizeUrl.searchParams.set('redirect_uri', `${this.config.appUrl}/shopify/callback`);
    authorizeUrl.searchParams.set('state', state);
    res.writeHead(302, { Location: authorizeUrl.toString() });
    res.end();
  }

  async handleOAuthCallback(url, res) {
    const params = url.searchParams;
    const shop = params.get('shop');
    const state = params.get('state');
    const stateExpiry = state ? this.oauthStates.get(state) : null;

    if (!verifyOAuthQuery(params, this.config.apiSecret) || shop !== this.config.shopDomain || !stateExpiry || stateExpiry < Date.now()) {
      sendMessagePage(res, 400, 'Install failed', 'The install request could not be verified. Start again from /shopify/install.');
      return;
    }
    this.oauthStates.delete(state);

    const { accessToken, scope } = await exchangeOAuthCode({
      shop,
      code: params.get('code'),
      apiKey: this.config.apiKey,
      apiSecret: this.config.apiSecret,
      fetchImpl: this.fetch
    });
    this.store.setShopToken(shop, accessToken, scope);
    await this.registerWebhooks(accessToken);
    sendMessagePage(res, 200, 'YouPI connected', `Your store ${shop} is connected. Customers who choose "${this.config.paymentMethodName}" at checkout will be asked to pay by UPI.`);
  }

  async registerWebhooks(accessToken) {
    const client = new ShopifyAdminClient({
      shop: this.config.shopDomain,
      accessToken,
      apiVersion: this.config.apiVersion,
      fetchImpl: this.fetch
    });
    await client.registerWebhook('ORDERS_CREATE', `${this.config.appUrl}/shopify/webhooks/orders-create`);
    await client.registerWebhook('APP_UNINSTALLED', `${this.config.appUrl}/shopify/webhooks/app-uninstalled`);
  }

  async handleShopifyWebhook(req, res, topic) {
    const raw = await readRawBody(req);
    if (!verifyShopifyWebhook(raw, req.headers['x-shopify-hmac-sha256'], this.config.apiSecret)) {
      sendJson(res, 401, { error: 'Invalid Shopify webhook signature' });
      return;
    }
    if (req.headers['x-shopify-shop-domain'] !== this.config.shopDomain) {
      sendJson(res, 403, { error: 'Unknown shop' });
      return;
    }

    const webhookId = req.headers['x-shopify-webhook-id'] || req.headers['x-shopify-event-id'];
    // Acknowledge fast: Shopify retries anything slower than 5s.
    sendJson(res, 200, { received: true });

    if (webhookId) {
      if (this.recentShopifyWebhookIds.has(webhookId)) return;
      this.recentShopifyWebhookIds.add(webhookId);
      if (this.recentShopifyWebhookIds.size > 2000) {
        this.recentShopifyWebhookIds.delete(this.recentShopifyWebhookIds.values().next().value);
      }
    }

    let payload;
    try {
      payload = JSON.parse(raw.toString('utf8'));
    } catch {
      return;
    }

    try {
      if (topic === 'orders/create') {
        const result = await this.bridge.handleOrderCreated(payload);
        this.log.log(`[Shopify Bridge] orders/create ${payload.id}:`, JSON.stringify(result));
      } else if (topic === 'app/uninstalled') {
        this.store.removeShop(this.config.shopDomain);
        this.log.log(`[Shopify Bridge] App uninstalled from ${this.config.shopDomain}; access token removed.`);
      }
    } catch (err) {
      this.log.error(`[Shopify Bridge] Processing ${topic} failed:`, err.message);
    }
  }

  async handleYoupiWebhook(req, res) {
    // Verify the HMAC over the exact raw bytes before parsing.
    const raw = await readRawBody(req);
    if (!this.bridge.verifyYoupiSignature(raw, req.headers['x-gateway-signature'])) {
      sendJson(res, 401, { error: 'Invalid webhook signature' });
      return;
    }

    let payload;
    try {
      payload = JSON.parse(raw.toString('utf8'));
    } catch {
      sendJson(res, 400, { error: 'Malformed JSON' });
      return;
    }

    try {
      const result = await this.bridge.handleYoupiEvent(payload, req.headers['x-gateway-delivery-id']);
      sendJson(res, 200, { received: true, ...result });
    } catch (err) {
      // Non-2xx makes YOUPI retry (e.g. Shopify briefly unavailable).
      this.log.error('[Shopify Bridge] YOUPI webhook processing failed:', err.message);
      sendJson(res, 503, { error: 'Temporarily unable to process webhook' });
    }
  }

  async handleExtensionPayment(req, res) {
    const auth = String(req.headers.authorization || '');
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    const session = verifySessionToken(token, this.config);
    if (!session) {
      sendJson(res, 401, { error: 'Invalid session token' }, EXTENSION_CORS);
      return;
    }

    let body = {};
    try {
      body = JSON.parse((await readRawBody(req)).toString('utf8') || '{}');
    } catch {}
    const orderId = numericOrderId(body.orderId);
    if (!orderId) {
      sendJson(res, 400, { error: 'orderId is required' }, EXTENSION_CORS);
      return;
    }

    try {
      const result = await this.bridge.ensurePayment(orderId);
      sendJson(res, 200, result, EXTENSION_CORS);
    } catch (err) {
      this.log.error(`[Shopify Bridge] Extension payment for order ${orderId} failed:`, err.message);
      sendJson(res, 502, { error: 'Payment service unavailable. Please try again shortly.' }, EXTENSION_CORS);
    }
  }

  async handlePayLink(orderId, sig, res) {
    if (!this.bridge.verifyPayLink(orderId, sig)) {
      sendMessagePage(res, 403, 'Invalid payment link', 'This payment link is not valid. Please use the link from your order confirmation.');
      return;
    }
    try {
      const result = await this.bridge.ensurePayment(orderId);
      if (result.state === 'PAY') {
        res.writeHead(303, { Location: result.checkoutUrl, 'Cache-Control': 'no-store' });
        res.end();
      } else if (result.state === 'PAID') {
        sendMessagePage(res, 200, 'Already paid', 'This order has already been paid. Thank you!');
      } else {
        sendMessagePage(res, 409, 'Nothing to pay', 'This order cannot be paid with UPI. Please contact the store.');
      }
    } catch (err) {
      this.log.error(`[Shopify Bridge] Pay link for order ${orderId} failed:`, err.message);
      sendMessagePage(res, 502, 'Try again shortly', 'We could not start your payment right now. Please try again in a minute.');
    }
  }
}
