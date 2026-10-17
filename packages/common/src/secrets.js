import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const rootDir = path.resolve(path.dirname(__filename), '../../..');

/**
 * Environment variable that overrides each generated secret.
 */
const SECRET_ENV_NAMES = {
  adminToken: 'YOUPI_ADMIN_TOKEN',
  serviceToken: 'YOUPI_SERVICE_TOKEN',
  adminPassword: 'YOUPI_ADMIN_PASSWORD',
  merchantSecretKey: 'YOUPI_MERCHANT_SECRET_KEY'
};

function generateSecretValues() {
  return {
    adminToken: crypto.randomBytes(32).toString('hex'),
    serviceToken: crypto.randomBytes(32).toString('hex'),
    adminPassword: crypto.randomBytes(12).toString('base64url'),
    merchantSecretKey: `sk_live_${crypto.randomBytes(24).toString('hex')}`
  };
}

function secretsFilePath() {
  return process.env.YOUPI_SECRETS_FILE || path.join(rootDir, 'data', '.youpi-secrets.json');
}

let cachedSecrets = null;

/**
 * Loads the gateway's internal credentials.
 *
 * Each value comes from its environment variable when set. Otherwise it is read from
 * (or generated once into) a local secrets file shared by every service on this host,
 * so a fresh install is locked down by default instead of running open.
 *
 * @returns {{ adminToken: string, serviceToken: string, adminPassword: string, merchantSecretKey: string, filePath: string, generated: boolean }}
 */
export function loadServiceSecrets() {
  if (cachedSecrets) return cachedSecrets;

  const filePath = secretsFilePath();
  let fileSecrets = null;
  let generated = false;

  const missingFromEnv = Object.values(SECRET_ENV_NAMES).some(name => !process.env[name]);
  if (missingFromEnv) {
    try {
      fileSecrets = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      const fresh = generateSecretValues();
      try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        // 'wx' fails if another service created the file first; then we read theirs.
        fs.writeFileSync(filePath, JSON.stringify(fresh, null, 2), { flag: 'wx', mode: 0o600 });
        fileSecrets = fresh;
        generated = true;
      } catch {
        try {
          fileSecrets = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        } catch {
          // Read-only filesystem: keep in-memory values for this process only.
          fileSecrets = fresh;
          generated = true;
        }
      }
    }
  }

  const resolved = {};
  for (const [key, envName] of Object.entries(SECRET_ENV_NAMES)) {
    resolved[key] = process.env[envName] || fileSecrets?.[key] || '';
  }

  cachedSecrets = { ...resolved, filePath, generated };
  if (generated) {
    console.log(`[YOUPI Security] Generated gateway credentials in ${filePath}.`);
    console.log('[YOUPI Security] Read the admin password and merchant secret key from that file; never commit it.');
  }
  return cachedSecrets;
}

/** Clears the cached secrets (tests only). */
export function resetServiceSecretsCache() {
  cachedSecrets = null;
}

/**
 * Constant-time string comparison that tolerates differing lengths.
 * @param {string} a
 * @param {string} b
 */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb) && a.length === b.length;
}

/**
 * Hashes a merchant API key for storage.
 * @param {string} apiKey
 */
export function hashApiKey(apiKey) {
  return crypto.createHash('sha256').update(String(apiKey)).digest('hex');
}

/**
 * Extracts a bearer token from an incoming request.
 * @param {{ headers: Record<string, any> }} req
 */
export function extractBearerToken(req) {
  const header = req.headers?.authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(String(header).trim());
  return match ? match[1].trim() : '';
}

/**
 * Headers internal observers send to the payment API.
 */
export function serviceAuthHeaders() {
  return { Authorization: `Bearer ${loadServiceSecrets().serviceToken}` };
}

/**
 * Secret embedded in the Android SMS gateway pairing QR. Uses ANDROID_ENROLLMENT_SECRET when set,
 * otherwise a value derived from the generated admin token (never a shared public default).
 */
export function androidEnrollmentSecret() {
  return process.env.ANDROID_ENROLLMENT_SECRET ||
    crypto.createHmac('sha256', loadServiceSecrets().adminToken).update('android-enrollment').digest('hex');
}
