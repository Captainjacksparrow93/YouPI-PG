import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const rootDir = path.resolve(__dirname, '../../..');

if (typeof process.loadEnvFile === 'function') {
  try {
    const rootEnv = path.join(rootDir, '.env');
    if (fs.existsSync(rootEnv)) process.loadEnvFile(rootEnv);
  } catch {}
}

/**
 * Reads bridge configuration from the environment.
 * @param {Record<string, string | undefined>} [env]
 */
export function loadBridgeConfig(env = process.env) {
  return {
    port: Number(env.SHOPIFY_BRIDGE_PORT || 6200),
    // Public HTTPS URL of this bridge (used for OAuth redirect and webhook registration).
    appUrl: (env.SHOPIFY_BRIDGE_URL || `http://localhost:${env.SHOPIFY_BRIDGE_PORT || 6200}`).replace(/\/+$/, ''),
    shopDomain: (env.SHOPIFY_SHOP_DOMAIN || '').trim().toLowerCase(),
    apiKey: env.SHOPIFY_API_KEY || '',
    apiSecret: env.SHOPIFY_API_SECRET || '',
    // Optional: a pre-issued Admin API token. When set, the OAuth install flow is not needed.
    adminAccessToken: env.SHOPIFY_ADMIN_ACCESS_TOKEN || '',
    apiVersion: env.SHOPIFY_API_VERSION || '2026-07',
    scopes: env.SHOPIFY_SCOPES || 'read_orders,write_orders',
    // Name of the Shopify manual payment method customers pick at checkout.
    paymentMethodName: (env.SHOPIFY_PAYMENT_METHOD_NAME || 'UPI (YouPI)').trim(),
    youpiApiUrl: (env.YOUPI_API_URL || env.BASE_PAYMENT_API_URL || 'http://localhost:6100').replace(/\/+$/, ''),
    youpiSecretKey: env.YOUPI_MERCHANT_SECRET_KEY || '',
    youpiWebhookSecret: env.YOUPI_WEBHOOK_SECRET || '',
    storePath: env.SHOPIFY_BRIDGE_STORE || path.join(rootDir, 'data', 'shopify-bridge.json')
  };
}

/**
 * Lists required settings that are missing.
 * @param {ReturnType<typeof loadBridgeConfig>} config
 */
export function missingConfig(config) {
  const missing = [];
  if (!config.shopDomain) missing.push('SHOPIFY_SHOP_DOMAIN');
  if (!config.apiSecret) missing.push('SHOPIFY_API_SECRET');
  if (!config.adminAccessToken && !config.apiKey) missing.push('SHOPIFY_API_KEY (or SHOPIFY_ADMIN_ACCESS_TOKEN)');
  if (!config.youpiSecretKey) missing.push('YOUPI_MERCHANT_SECRET_KEY');
  if (!config.youpiWebhookSecret) missing.push('YOUPI_WEBHOOK_SECRET');
  return missing;
}
