// Fixed credentials for the automated test suites. Import this first in any test that talks to the payment API.
process.env.YOUPI_ADMIN_TOKEN ||= 'test_admin_token_0000000000000000';
process.env.YOUPI_SERVICE_TOKEN ||= 'test_service_token_000000000000';
process.env.YOUPI_ADMIN_PASSWORD ||= 'test-admin-password';
process.env.YOUPI_MERCHANT_SECRET_KEY ||= 'sk_test_merchant_secret_key_0000';
process.env.ANDROID_ENROLLMENT_SECRET ||= 'test_android_enrollment_secret_000';
process.env.YOUPI_ENABLE_DEV_TOOLS ||= 'true';

export const TEST_ADMIN_TOKEN = process.env.YOUPI_ADMIN_TOKEN;
export const TEST_SERVICE_TOKEN = process.env.YOUPI_SERVICE_TOKEN;
export const TEST_MERCHANT_SECRET_KEY = process.env.YOUPI_MERCHANT_SECRET_KEY;
export const adminAuthHeaders = () => ({ Authorization: `Bearer ${TEST_ADMIN_TOKEN}` });

// Legacy suites exercise business logic over HTTP without credentials. Attach the admin
// token (in its own header, so customer Bearer tokens still work) to loopback requests unless a test opts out with an `x-test-anonymous` header.
import http from 'node:http';

function isLoopback(host) {
  return /^(localhost|127\.0\.0\.1|\[?::1\]?)(:\d+)?$/.test(String(host || ''));
}

function withAdminAuth(headers) {
  const lower = Object.fromEntries(Object.keys(headers || {}).map(k => [k.toLowerCase(), k]));
  if (lower['x-test-anonymous']) {
    const copy = { ...headers };
    delete copy[lower['x-test-anonymous']];
    return copy;
  }
  return { ...(headers || {}), 'X-Youpi-Admin-Token': TEST_ADMIN_TOKEN };
}

if (!globalThis.__youpiTestAuthPatched) {
  globalThis.__youpiTestAuthPatched = true;

  const originalRequest = http.request;
  http.request = function patchedRequest(url, options, callback) {
    let target = url;
    let opts = options;
    if (typeof url === 'string' || url instanceof URL) {
      target = new URL(url);
      if (typeof options === 'function') { callback = options; opts = {}; }
      opts = { ...(opts || {}) };
      if (isLoopback(target.host)) opts.headers = withAdminAuth(opts.headers);
      return originalRequest.call(this, target, opts, callback);
    }
    // http.request(options, callback)
    callback = options;
    opts = { ...url };
    if (isLoopback(opts.hostname || opts.host)) opts.headers = withAdminAuth(opts.headers);
    return originalRequest.call(this, opts, callback);
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = function patchedFetch(input, init = {}) {
    try {
      const target = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      if (isLoopback(target.host)) {
        const headers = Object.fromEntries(new Headers(init.headers || {}).entries());
        init = { ...init, headers: withAdminAuth(headers) };
      }
    } catch {}
    return originalFetch.call(this, input, init);
  };
}
