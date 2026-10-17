import { loadServiceSecrets, safeEqual, hashApiKey, extractBearerToken } from '@youpi/common';
import { HttpServer } from './server.js';

/**
 * Access levels, from least to most privileged.
 *  - PUBLIC:   customer checkout traffic (session UUIDs act as capabilities).
 *  - MERCHANT: the merchant's own backend, authenticated with its secret API key.
 *  - SERVICE:  internal observers (Gmail / SMS) submitting bank observations.
 *  - ADMIN:    merchant admin dashboard.
 *  - DEV:      fake-payment simulators; admin-only AND disabled unless YOUPI_ENABLE_DEV_TOOLS=true.
 */
export const Access = Object.freeze({
  PUBLIC: 'PUBLIC',
  MERCHANT: 'MERCHANT',
  SERVICE: 'SERVICE',
  ADMIN: 'ADMIN',
  DEV: 'DEV'
});

export function isDevToolsEnabled() {
  return process.env.YOUPI_ENABLE_DEV_TOOLS === 'true';
}

export function isPublicPaymentCreateAllowed() {
  return process.env.YOUPI_ALLOW_PUBLIC_PAYMENT_CREATE === 'true';
}

/**
 * Decides which access level a request needs.
 * @param {string} method
 * @param {string} pathname
 */
export function classifyRoute(method, pathname) {
  if (/^\/api\/v1\/checkout\/[^/]+\/simulate-observation$/.test(pathname)) return Access.DEV;
  if (pathname.startsWith('/api/v1/admin/dev/')) return Access.DEV;

  // Gmail observer reads its OAuth credentials and stores refreshed tokens here.
  if (pathname === '/api/v1/admin/gmail/credentials') return Access.SERVICE;
  if (pathname.startsWith('/api/v1/admin/')) return Access.ADMIN;

  if (pathname === '/api/v1/pollers/events' || pathname === '/api/v1/pollers/active-window') return Access.SERVICE;

  if (pathname === '/api/v1/payments' && method === 'POST') {
    return isPublicPaymentCreateAllowed() ? Access.PUBLIC : Access.MERCHANT;
  }
  if (/^\/api\/v1\/payments\/[^/]+\/cod$/.test(pathname)) return Access.MERCHANT;
  if (pathname.startsWith('/api/v1/orders/')) return Access.MERCHANT;
  if (pathname.startsWith('/api/v1/devices/customer/')) return Access.ADMIN;

  // Android pairing / signed SMS ingest / heartbeat verify their own credentials.
  return Access.PUBLIC;
}

/**
 * Builds the request guard installed on the payment API HttpServer.
 * @param {{ merchantRepo: import('@youpi/db').MerchantRepository }} ctx
 */
export function createRouteGuard(ctx) {
  const secrets = loadServiceSecrets();

  // Authorization may carry a customer session token on checkout routes, so the dedicated
  // X-Youpi-Admin-Token / X-Youpi-Service-Token headers are checked independently of it.
  function isAdmin(req) {
    return safeEqual(extractBearerToken(req), secrets.adminToken) ||
      safeEqual(String(req.headers['x-youpi-admin-token'] || ''), secrets.adminToken);
  }

  function isService(req) {
    return isAdmin(req) ||
      safeEqual(extractBearerToken(req), secrets.serviceToken) ||
      safeEqual(String(req.headers['x-youpi-service-token'] || ''), secrets.serviceToken);
  }

  /**
   * Resolves the merchant that owns the presented secret API key.
   * @returns {any | null}
   */
  function merchantForApiKey(req) {
    const key = extractBearerToken(req);
    if (!key) return null;

    const keyHash = hashApiKey(key);
    for (const merchant of ctx.merchantRepo.findAll()) {
      if (merchant.branding?.apiKeyHash && safeEqual(keyHash, merchant.branding.apiKeyHash)) {
        return merchant;
      }
    }
    if (safeEqual(key, secrets.merchantSecretKey)) {
      return ctx.merchantRepo.getDefault();
    }
    return null;
  }

  function deny(res, status, error) {
    HttpServer.json(res, status, { success: false, error });
    return false;
  }

  /**
   * @returns {boolean} true when the request may proceed; otherwise a response was sent.
   */
  return function guard(req, res, method, pathname) {
    const access = classifyRoute(method, pathname);

    switch (access) {
      case Access.PUBLIC:
        return true;

      case Access.DEV:
        if (!isDevToolsEnabled()) return deny(res, 404, `Route not found: ${method} ${pathname}`);
        if (!isAdmin(req)) return deny(res, 401, 'Admin authentication required.');
        req.auth = { role: Access.ADMIN };
        return true;

      case Access.ADMIN:
        if (!isAdmin(req)) return deny(res, 401, 'Admin authentication required.');
        req.auth = { role: Access.ADMIN };
        return true;

      case Access.SERVICE:
        if (!isService(req)) return deny(res, 401, 'Service authentication required.');
        req.auth = { role: Access.SERVICE };
        return true;

      case Access.MERCHANT: {
        if (isAdmin(req)) {
          req.auth = { role: Access.ADMIN };
          return true;
        }
        const merchant = merchantForApiKey(req);
        if (!merchant) {
          return deny(res, 401, 'Merchant authentication required: send "Authorization: Bearer <merchant secret key>" from your server. Never call this endpoint from a browser.');
        }
        req.auth = { role: Access.MERCHANT, merchant };
        return true;
      }

      default:
        return deny(res, 403, 'Forbidden');
    }
  };
}
