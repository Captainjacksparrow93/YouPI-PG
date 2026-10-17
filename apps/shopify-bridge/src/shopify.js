import crypto from 'node:crypto';
import { safeEqual } from '@youpi/common';

const SHOP_DOMAIN_PATTERN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

export function isValidShopDomain(shop) {
  return SHOP_DOMAIN_PATTERN.test(String(shop || ''));
}

/**
 * Verifies the X-Shopify-Hmac-Sha256 header of a Shopify webhook (base64 HMAC of the raw body).
 * @param {Buffer | string} rawBody
 * @param {string} hmacHeader
 * @param {string} apiSecret
 */
export function verifyShopifyWebhook(rawBody, hmacHeader, apiSecret) {
  if (!hmacHeader || !apiSecret) return false;
  const digest = crypto.createHmac('sha256', apiSecret).update(rawBody).digest('base64');
  return safeEqual(digest, String(hmacHeader));
}

/**
 * Verifies the `hmac` query parameter Shopify adds to OAuth redirects.
 * @param {URLSearchParams} params
 * @param {string} apiSecret
 */
export function verifyOAuthQuery(params, apiSecret) {
  const hmac = params.get('hmac');
  if (!hmac || !apiSecret) return false;
  const message = [...params.entries()]
    .filter(([key]) => key !== 'hmac' && key !== 'signature')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
  const digest = crypto.createHmac('sha256', apiSecret).update(message).digest('hex');
  return safeEqual(digest, hmac);
}

/**
 * Verifies a Shopify session token (HS256 JWT) sent by a checkout / customer account UI extension.
 * @param {string} token
 * @param {{ apiKey: string, apiSecret: string, shopDomain: string }} config
 * @returns {{ shop: string, payload: any } | null}
 */
export function verifySessionToken(token, config) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, signatureB64] = parts;

  let header;
  let payload;
  try {
    header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'));
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (header.alg !== 'HS256') return null;

  const expected = crypto.createHmac('sha256', config.apiSecret).update(`${headerB64}.${payloadB64}`).digest('base64url');
  if (!safeEqual(expected, signatureB64)) return null;

  const now = Math.floor(Date.now() / 1000);
  const leeway = 10;
  if (typeof payload.exp !== 'number' || payload.exp + leeway < now) return null;
  if (typeof payload.nbf === 'number' && payload.nbf - leeway > now) return null;
  if (config.apiKey && payload.aud !== config.apiKey) return null;

  let shop = '';
  try {
    shop = new URL(payload.dest).hostname;
  } catch {
    return null;
  }
  if (shop !== config.shopDomain) return null;
  return { shop, payload };
}

/** Numeric ID from "gid://shopify/Order/123" or "gid://shopify/OrderIdentity/123" (or a bare number). */
export function numericOrderId(id) {
  const match = /(\d+)$/.exec(String(id || ''));
  return match ? match[1] : null;
}

export function orderGid(numericId) {
  return `gid://shopify/Order/${numericId}`;
}

/** Converts a Shopify decimal money string ("499.00") to integer paise without float rounding. */
export function moneyToPaise(amount) {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(amount ?? '').trim());
  if (!match) throw new Error(`Invalid money amount: ${amount}`);
  return Number(match[1]) * 100 + Number((match[2] || '0').padEnd(2, '0'));
}

export class ShopifyAdminClient {
  /**
   * @param {{ shop: string, accessToken: string, apiVersion: string, fetchImpl?: typeof fetch }} options
   */
  constructor({ shop, accessToken, apiVersion, fetchImpl }) {
    this.shop = shop;
    this.accessToken = accessToken;
    this.apiVersion = apiVersion;
    this.fetch = fetchImpl || fetch;
    this.endpoint = `https://${shop}/admin/api/${apiVersion}/graphql.json`;
  }

  async graphql(query, variables = {}) {
    const res = await this.fetch(this.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': this.accessToken
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(15000)
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.errors) {
      throw new Error(`Shopify GraphQL error [HTTP ${res.status}]: ${JSON.stringify(body.errors || body)}`);
    }
    return body.data;
  }

  async getOrder(numericId) {
    const data = await this.graphql(`
      query YoupiOrder($id: ID!) {
        order(id: $id) {
          id
          name
          email
          phone
          cancelledAt
          displayFinancialStatus
          paymentGatewayNames
          totalOutstandingSet { shopMoney { amount currencyCode } }
          customer { firstName lastName }
        }
      }`, { id: orderGid(numericId) });
    return data.order;
  }

  async markOrderPaid(numericId) {
    const data = await this.graphql(`
      mutation YoupiMarkPaid($input: OrderMarkAsPaidInput!) {
        orderMarkAsPaid(input: $input) {
          order { id displayFinancialStatus }
          userErrors { field message }
        }
      }`, { input: { id: orderGid(numericId) } });
    const result = data.orderMarkAsPaid;
    if (result.userErrors?.length) {
      throw new Error(`orderMarkAsPaid failed: ${JSON.stringify(result.userErrors)}`);
    }
    return result.order;
  }

  async recordPaymentDetails(numericId, { utr, paymentId }) {
    const tags = ['youpi-paid'];
    const data = await this.graphql(`
      mutation YoupiRecord($id: ID!, $tags: [String!]!, $metafields: [MetafieldsSetInput!]!) {
        tagsAdd(id: $id, tags: $tags) { userErrors { field message } }
        metafieldsSet(metafields: $metafields) { userErrors { field message } }
      }`, {
      id: orderGid(numericId),
      tags,
      metafields: [
        { ownerId: orderGid(numericId), namespace: 'youpi', key: 'utr', type: 'single_line_text_field', value: utr || 'UNKNOWN' },
        { ownerId: orderGid(numericId), namespace: 'youpi', key: 'payment_id', type: 'single_line_text_field', value: paymentId }
      ]
    });
    const errors = [...(data.tagsAdd?.userErrors || []), ...(data.metafieldsSet?.userErrors || [])];
    if (errors.length) throw new Error(`Recording payment details failed: ${JSON.stringify(errors)}`);
  }

  async registerWebhook(topic, callbackUrl) {
    const data = await this.graphql(`
      mutation YoupiWebhook($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) {
        webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) {
          webhookSubscription { id }
          userErrors { field message }
        }
      }`, { topic, sub: { callbackUrl, format: 'JSON' } });
    const errors = data.webhookSubscriptionCreate.userErrors || [];
    // "Address for this topic has already been taken" means it is already registered.
    if (errors.length && !errors.some(e => /already been taken/i.test(e.message))) {
      throw new Error(`webhookSubscriptionCreate(${topic}) failed: ${JSON.stringify(errors)}`);
    }
  }
}

/**
 * Exchanges an OAuth authorization code for an offline Admin API access token.
 */
export async function exchangeOAuthCode({ shop, code, apiKey, apiSecret, fetchImpl = fetch }) {
  const res = await fetchImpl(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: apiKey, client_secret: apiSecret, code }),
    signal: AbortSignal.timeout(15000)
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw new Error(`OAuth token exchange failed [HTTP ${res.status}]`);
  }
  return { accessToken: body.access_token, scope: body.scope };
}
