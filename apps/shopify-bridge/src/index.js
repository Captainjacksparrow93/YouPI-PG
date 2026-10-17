import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBridgeConfig, missingConfig } from './config.js';
import { BridgeStore } from './store.js';
import { ShopifyBridgeServer } from './server.js';

export async function startShopifyBridge(options = {}) {
  const config = { ...loadBridgeConfig(), ...(options.config || {}) };
  const missing = missingConfig(config);
  if (missing.length && !options.allowIncompleteConfig) {
    throw new Error(`Shopify bridge is missing configuration: ${missing.join(', ')}. See docs/SHOPIFY_INTEGRATION.md.`);
  }

  const store = options.store || new BridgeStore(config.storePath);
  const bridgeServer = new ShopifyBridgeServer({ config, store, fetchImpl: options.fetchImpl, logger: options.logger });
  const rawServer = bridgeServer.createServer();

  return new Promise(resolve => {
    const instance = rawServer.listen(options.port ?? config.port, () => {
      const port = instance.address().port;
      console.log(`[Shopify Bridge] Listening on port ${port} for ${config.shopDomain || '(no shop configured)'}`);
      resolve({
        port,
        bridge: bridgeServer.bridge,
        store,
        close: () => new Promise(cb => instance.close(cb))
      });
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startShopifyBridge().catch(err => {
    console.error(`[Shopify Bridge] ${err.message}`);
    process.exit(1);
  });
}
