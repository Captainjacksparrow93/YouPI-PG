import crypto from 'node:crypto';
import { safeEqual } from '@youpi/common';
import { ShopifyAdminClient, moneyToPaise, orderGid } from './shopify.js';

const OPEN_YOUPI_STATUSES = new Set(['INITIATED', 'QUEUED', 'ACTIVE', 'PROCESSING']);

export function paiseToRupees(paise) {
  return `${Math.floor(paise / 100)}.${String(paise % 100).padStart(2, '0')}`;
}

/**
 * Business logic connecting Shopify orders to YOUPI payment sessions.
 *
 * Trust model:
 *  - Amounts always come from Shopify's Admin API / signed webhooks, never from the browser.
 *  - A Shopify order is marked paid only on a YOUPI webhook whose HMAC verifies, whose amount
 *    equals what the bridge asked YOUPI to collect, and which still equals the order's
 *    outstanding balance in Shopify at that moment.
 */
export class ShopifyYoupiBridge {
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
  }

  shopify() {
    const accessToken = this.config.adminAccessToken || this.store.getShopToken(this.config.shopDomain);
    if (!accessToken) {
      throw new Error(`Shopify store ${this.config.shopDomain} is not connected. Open ${this.config.appUrl}/shopify/install to install the app.`);
    }
    return new ShopifyAdminClient({
      shop: this.config.shopDomain,
      accessToken,
      apiVersion: this.config.apiVersion,
      fetchImpl: this.fetch
    });
  }

  /** Signed fallback link a customer can open to pay for an order. */
  payLink(shopifyOrderId) {
    const sig = crypto.createHmac('sha256', this.config.apiSecret).update(`pay:${shopifyOrderId}`).digest('hex');
    return `${this.config.appUrl}/pay/${shopifyOrderId}?sig=${sig}`;
  }

  verifyPayLink(shopifyOrderId, sig) {
    const expected = crypto.createHmac('sha256', this.config.apiSecret).update(`pay:${shopifyOrderId}`).digest('hex');
    return safeEqual(expected, String(sig || ''));
  }

  usesYoupi(gatewayNames = []) {
    const wanted = this.config.paymentMethodName.toLowerCase();
    return gatewayNames.some(name => String(name).trim().toLowerCase() === wanted);
  }

  async youpiRequest(path, { method = 'GET', body } = {}) {
    const res = await this.fetch(`${this.config.youpiApiUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.youpiSecretKey}`
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000)
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`YOUPI ${method} ${path} failed [HTTP ${res.status}]: ${json.error || JSON.stringify(json)}`);
    }
    return json;
  }

  /**
   * Returns an open YOUPI payment for a Shopify order, creating one when needed.
   * Always re-reads the order from Shopify so the amount is authoritative.
   *
   * @param {string} shopifyOrderId numeric ID
   * @returns {Promise<{ state: 'PAY' | 'PAID' | 'NOT_APPLICABLE', reason?: string, checkoutUrl?: string, amount?: string, paymentId?: string }>}
   */
  async ensurePayment(shopifyOrderId) {
    const order = await this.shopify().getOrder(shopifyOrderId);
    if (!order) return { state: 'NOT_APPLICABLE', reason: 'ORDER_NOT_FOUND' };
    if (!this.usesYoupi(order.paymentGatewayNames)) return { state: 'NOT_APPLICABLE', reason: 'OTHER_PAYMENT_METHOD' };
    if (order.cancelledAt) return { state: 'NOT_APPLICABLE', reason: 'ORDER_CANCELLED' };

    const outstanding = order.totalOutstandingSet?.shopMoney;
    if (outstanding?.currencyCode !== 'INR') {
      return { state: 'NOT_APPLICABLE', reason: 'CURRENCY_NOT_INR' };
    }
    const amountPaise = moneyToPaise(outstanding.amount);
    if (order.displayFinancialStatus === 'PAID' || amountPaise === 0) {
      return { state: 'PAID' };
    }

    const existing = this.store.getOrder(shopifyOrderId);
    if (existing?.paymentId && existing.amountPaise === amountPaise) {
      try {
        const current = await this.youpiRequest(`/api/v1/payments/${existing.paymentId}`);
        if (OPEN_YOUPI_STATUSES.has(current.internalStatus || current.status)) {
          return { state: 'PAY', checkoutUrl: existing.checkoutUrl, amount: paiseToRupees(amountPaise), paymentId: existing.paymentId };
        }
        if ((current.internalStatus || current.status) === 'SUCCESS') {
          // Paid in YOUPI; the webhook will (or did) mark Shopify paid.
          return { state: 'PAID' };
        }
      } catch (err) {
        this.log.warn(`[Shopify Bridge] Could not read YOUPI payment ${existing.paymentId}: ${err.message}`);
      }
    }

    const customerName = [order.customer?.firstName, order.customer?.lastName].filter(Boolean).join(' ');
    const created = await this.youpiRequest('/api/v1/payments', {
      method: 'POST',
      body: {
        orderId: `SHOPIFY-${shopifyOrderId}`,
        amount: paiseToRupees(amountPaise),
        currency: 'INR',
        customer: (order.email || order.phone)
          ? { email: order.email || undefined, phoneNumber: order.phone || undefined, fullName: customerName || undefined }
          : undefined,
        metadata: {
          shopify_order_id: String(shopifyOrderId),
          shopify_order_name: order.name,
          shopify_shop: this.config.shopDomain
        }
      }
    });

    this.store.upsertOrder(shopifyOrderId, {
      orderName: order.name,
      paymentId: created.paymentId,
      youpiOrderId: created.orderId,
      checkoutUrl: created.checkoutUrl,
      amountPaise,
      status: 'PENDING'
    });

    return { state: 'PAY', checkoutUrl: created.checkoutUrl, amount: paiseToRupees(amountPaise), paymentId: created.paymentId };
  }

  /**
   * Handles a verified `orders/create` Shopify webhook payload.
   */
  async handleOrderCreated(order) {
    if (!this.usesYoupi(order.payment_gateway_names || [])) return { skipped: 'OTHER_PAYMENT_METHOD' };

    const result = await this.ensurePayment(String(order.id));
    if (result.state === 'PAY') {
      // Store the signed pay link on the order so staff and notification templates
      // ({{ order.metafields.youpi.pay_url }}) can share it with the customer.
      try {
        await this.shopify().graphql(`
          mutation YoupiPayUrl($metafields: [MetafieldsSetInput!]!) {
            metafieldsSet(metafields: $metafields) { userErrors { field message } }
          }`, {
          metafields: [{
            ownerId: orderGid(order.id),
            namespace: 'youpi',
            key: 'pay_url',
            type: 'url',
            value: this.payLink(String(order.id))
          }]
        });
      } catch (err) {
        this.log.warn(`[Shopify Bridge] Could not save pay link on order ${order.id}: ${err.message}`);
      }
    }
    return result;
  }

  /**
   * Verifies the HMAC of a YOUPI webhook over the raw body.
   * @param {Buffer} rawBody
   * @param {string} signatureHeader "sha256=<hex>"
   */
  verifyYoupiSignature(rawBody, signatureHeader) {
    const expected = 'sha256=' + crypto.createHmac('sha256', this.config.youpiWebhookSecret).update(rawBody).digest('hex');
    return safeEqual(expected, String(signatureHeader || ''));
  }

  /**
   * Handles a YOUPI webhook whose signature has already been verified.
   * @param {any} payload
   * @param {string} deliveryId
   */
  async handleYoupiEvent(payload, deliveryId) {
    if (this.store.hasProcessedDelivery(deliveryId)) return { duplicate: true };

    const shopifyOrderId = payload?.metadata?.shopify_order_id;
    if (!shopifyOrderId) return { ignored: 'NOT_A_SHOPIFY_PAYMENT' };

    const link = this.store.getOrder(shopifyOrderId);
    if (payload.event !== 'SUCCESS') {
      if (link && link.paymentId === payload.paymentId) {
        this.store.upsertOrder(shopifyOrderId, { status: payload.event });
      }
      this.store.markDeliveryProcessed(deliveryId);
      return { ignored: `EVENT_${payload.event}` };
    }

    if (!link) {
      this.log.error(`[Shopify Bridge] SUCCESS for unknown Shopify order ${shopifyOrderId} (payment ${payload.paymentId}). Not marking paid.`);
      return { flagged: 'UNKNOWN_ORDER' };
    }
    if (link.status === 'PAID') {
      this.store.markDeliveryProcessed(deliveryId);
      return { alreadyPaid: true };
    }

    const paidPaise = Number(payload.amountPaise);
    if (payload.currency !== 'INR' || paidPaise !== link.amountPaise) {
      this.store.upsertOrder(shopifyOrderId, { status: 'NEEDS_REVIEW', reviewReason: `YOUPI amount ${paidPaise} != expected ${link.amountPaise}`, lastPaymentId: payload.paymentId, utr: payload.utr || null });
      this.store.markDeliveryProcessed(deliveryId);
      this.log.error(`[Shopify Bridge] Amount mismatch for order ${shopifyOrderId}: paid ${paidPaise} paise, expected ${link.amountPaise}. Flagged for review.`);
      return { flagged: 'AMOUNT_MISMATCH' };
    }

    const client = this.shopify();
    const order = await client.getOrder(shopifyOrderId);
    const outstanding = order?.totalOutstandingSet?.shopMoney;
    if (!order || order.cancelledAt || outstanding?.currencyCode !== 'INR' || moneyToPaise(outstanding.amount) !== paidPaise) {
      this.store.upsertOrder(shopifyOrderId, { status: 'NEEDS_REVIEW', reviewReason: 'Shopify order changed, cancelled, or balance differs from amount paid', lastPaymentId: payload.paymentId, utr: payload.utr || null });
      this.store.markDeliveryProcessed(deliveryId);
      this.log.error(`[Shopify Bridge] Order ${shopifyOrderId} no longer matches the payment. Flagged for review; refund or reconcile manually.`);
      return { flagged: 'ORDER_CHANGED' };
    }

    await client.markOrderPaid(shopifyOrderId);
    try {
      await client.recordPaymentDetails(shopifyOrderId, { utr: payload.utr, paymentId: payload.paymentId });
    } catch (err) {
      this.log.warn(`[Shopify Bridge] Order ${shopifyOrderId} marked paid but UTR not recorded: ${err.message}`);
    }

    this.store.upsertOrder(shopifyOrderId, { status: 'PAID', paidPaymentId: payload.paymentId, utr: payload.utr || null, paidAt: new Date().toISOString() });
    this.store.markDeliveryProcessed(deliveryId);
    this.log.log(`[Shopify Bridge] Order ${shopifyOrderId} marked PAID (UTR ${payload.utr || 'n/a'}).`);
    return { markedPaid: true };
  }
}
