import fs from 'node:fs';
import path from 'node:path';

/**
 * Small JSON-file store for the bridge: the shop's access token, order <-> payment links,
 * and processed webhook IDs. Writes are atomic (temp file + rename).
 */
export class BridgeStore {
  /**
   * @param {string | null} filePath null keeps everything in memory (tests).
   */
  constructor(filePath) {
    this.filePath = filePath;
    this.data = { shops: {}, orders: {}, processedDeliveries: [] };
    if (filePath && fs.existsSync(filePath)) {
      try {
        this.data = { ...this.data, ...JSON.parse(fs.readFileSync(filePath, 'utf8')) };
      } catch (err) {
        throw new Error(`Cannot read Shopify bridge store at ${filePath}: ${err.message}`);
      }
    }
  }

  save() {
    if (!this.filePath) return;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.filePath);
  }

  getShopToken(shop) {
    return this.data.shops[shop]?.accessToken || null;
  }

  setShopToken(shop, accessToken, scope) {
    this.data.shops[shop] = { accessToken, scope, installedAt: new Date().toISOString() };
    this.save();
  }

  removeShop(shop) {
    delete this.data.shops[shop];
    this.save();
  }

  /** @param {string} shopifyOrderId numeric Shopify order ID */
  getOrder(shopifyOrderId) {
    return this.data.orders[String(shopifyOrderId)] || null;
  }

  upsertOrder(shopifyOrderId, fields) {
    const key = String(shopifyOrderId);
    this.data.orders[key] = { ...(this.data.orders[key] || {}), ...fields, updatedAt: new Date().toISOString() };
    this.save();
    return this.data.orders[key];
  }

  hasProcessedDelivery(deliveryId) {
    return Boolean(deliveryId) && this.data.processedDeliveries.includes(deliveryId);
  }

  markDeliveryProcessed(deliveryId) {
    if (!deliveryId) return;
    this.data.processedDeliveries.push(deliveryId);
    if (this.data.processedDeliveries.length > 5000) {
      this.data.processedDeliveries = this.data.processedDeliveries.slice(-5000);
    }
    this.save();
  }
}
