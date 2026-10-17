# Security Review & Pre-Launch Findings (October 2026)

This review covers the problems reported before YOUPI PG touches real money, plus further issues
found while fixing them. `apps/payment-api/src/__tests__/security-hardening.test.js` reproduces each
attack and checks that it is now blocked.

## Fixed

| # | Finding | Impact | Fix |
|---|---------|--------|-----|
| 1 | `POST /api/v1/checkout/:id/simulate-observation` took any SMS text with no auth. The fraud check only caught fakes sent from the customer's own number. | Anyone could mark any session **SUCCESS** with a made-up bank SMS. | Simulators (`/checkout/:id/simulate-observation`, `/admin/dev/*`) return **404** unless `YOUPI_ENABLE_DEV_TOOLS=true`. Even then they need the admin token. |
| 2 | `POST /api/v1/pollers/events` (observer ingest) had no auth and accepted `amount` + `utr` directly. | A second, simpler way to fake payments. | Requires the **service token** (`YOUPI_SERVICE_TOKEN`). Gmail/SMS observers send it automatically. The `isTest` / `testModeActive` flags are ignored unless dev tools are on. |
| 3 | Android SMS ingest checked the HMAC only *if* the signature headers were present. | Knowing a device ID (also listed by the open admin API) was enough to inject SMS. | `X-Timestamp` + `X-Signature` are now mandatory (the Android app already sent them). |
| 4 | Android pairing accepted hardcoded tokens (`youpi_sms_pair_token_secure`, `pair_00000000`) and a published default enrollment secret. | Anyone could pair a rogue "SMS gateway" and sign fake SMS. | Only the real enrollment secret is accepted. If `ANDROID_ENROLLMENT_SECRET` is not set, it is derived from the admin token, so it is unique per install. |
| 5 | The entire `/api/v1/admin/*` API had no auth. The public checkout portal and the demo store also proxied it. | Anyone could add `attacker@okhdfc`, make it the active VPA, change the webhook URL/secret, read Gmail OAuth refresh tokens and client secret, clear queues, ban or unban customers, or set the Cloudflare tunnel command (run as a shell command at startup). | `/api/v1/admin/*` requires the **admin token**. Merchant Admin has a password login (signed HttpOnly SameSite=Strict cookie, lockout after 10 failures) and injects the token server-side. The checkout portal and demo store no longer proxy admin or observer routes. |
| 6 | `POST /api/v1/payments` took any amount from anyone, and `X-Merchant-Id` was trusted. | The amount was attacker-chosen, so every integration had to re-check amounts. | Requires the merchant **secret key** (`Authorization: Bearer sk_...`). Keys can be rotated with `POST /api/v1/admin/api-keys/rotate` and are stored hashed. `/api/v1/orders/*` and `/payments/:id/cod` (customer PII) also require it. The legacy browser flow is available only with `YOUPI_ALLOW_PUBLIC_PAYMENT_CREATE=true`. |
| 7 | Retried orders became `ORDER-1-R4821`, and the webhook reported the renamed ID. | Integrations could not match payments to orders. | Sessions store `metadata.merchantOrderId`. The webhook `orderId` is now the merchant's original ID, with the internal one in `attemptOrderId`. The API also returns `merchantOrderId`. |
| 8 | The webhook omitted `utr`, although the docs promised it. | No bank reference for reconciliation. | The webhook and `GET /api/v1/payments/:id` include the UTR of the observation that settled the payment. |
| 9 | `WebhookEngine.retryPending()` was never called. | A failed webhook delivery was never retried, so orders could be paid but never marked paid. | The payment API runs the retry loop every 5 s (backoff 5 s → 1 h). |
| 10 | The Gmail OAuth redirect URI was hardcoded to the original author's domain (`pay-gmail.gauravtesting.online`). | Your Google OAuth authorization code would be sent to a third-party host. | Uses `GMAIL_REDIRECT_URI` (default `http://localhost:6003/oauth/callback`). |
| 11 | The Gmail observer trusted the `From:` header. | A spoofed "credit alert" email could count as a bank observation. | Messages must pass Gmail's DMARC or DKIM check for the From domain, as recorded by `mx.google.com`. |
| 12 | The control center (start/stop all services, live logs) listened on all interfaces with no auth. | Remote denial of service and log disclosure. | Binds to `127.0.0.1` (`CONTROL_CENTER_HOST`). Reach it through the logged-in Merchant Admin. |

### Where credentials come from

`packages/common/src/secrets.js`: each value comes from its env var. If the env var is unset, the
value is generated once into `data/.youpi-secrets.json` (mode 600, git-ignored), which every service
on the host shares. A fresh install is therefore locked by default rather than open.

| Secret | Used by |
|--------|---------|
| `YOUPI_ADMIN_TOKEN` | Merchant Admin → payment API admin routes |
| `YOUPI_SERVICE_TOKEN` | Gmail/SMS observers → `/pollers/*`, Gmail credentials |
| `YOUPI_ADMIN_PASSWORD` | Merchant Admin login page |
| `YOUPI_MERCHANT_SECRET_KEY` | Your backend / Shopify bridge → `POST /api/v1/payments` |

### Breaking changes for existing integrations

- Browser-only `Youpi.pay({ amount })` / `data-amount` buttons now get **401** from `/api/v1/payments`.
  Create the payment on your server and pass `paymentId` (see AGENTS.md, "Step 1b"). The bundled demo
  store does this through its own server proxy.
- Webhook `orderId` is now the original merchant order ID. Use `attemptOrderId` if you relied on the
  `-R####` value.
- Anything that called `/api/v1/admin/*` directly must send `Authorization: Bearer <YOUPI_ADMIN_TOKEN>`.

## Not fixed in code: decisions for you

### Throughput: one payer per UPI ID at a time
Payments are matched to bank credits by **amount + time window on one VPA**. So each receiving VPA
serves one active customer for up to 5 minutes, and everyone else queues. This is a property of the
design, not a bug. The code enforces "one active VPA per merchant" (`activateAccount`), and the
Android/Gmail observers attribute every observation to that single account. Running several VPAs in
parallel needs:

1. A pool of active receiving accounts per merchant, each with its own observer (its own bank SMS
   phone or Gmail inbox), and observations tagged with the account they came from.
2. Slot acquisition picking any free account in the pool, with the QR built from the chosen account
   at activation time (not at session creation).
3. Admin UI changes to manage the pool.

This is a multi-service change and is left as a follow-up. Until then, expect queueing whenever more
than about 10 customers an hour pay.

### Licence
`package.json` says `"license": "Commercial"` and there is no LICENSE file. Without written permission
from the copyright holder (author listed as "Antigravity Systems"), you have no clear right to run,
modify, or resell this code for clients. Get a written licence or assignment before deploying it for
anyone, including Biotane. These changes do not alter the licence.

### Regulatory and bank compliance
- Collecting **business** revenue into **personal** UPI IDs can breach bank account terms and lead to
  account freezes. Merchants should use a current account and a merchant/business VPA.
- Payment confirmation by reading SMS and email is a heuristic: no bank or NPCI API confirms the
  payment. A delayed or missing alert means a paid order shows as unpaid, which needs manual
  reconciliation against bank statements.
- Reading a Gmail inbox and SMS needs the account holder's consent. Process only bank alerts and
  keep the data on infrastructure you control.
- This is not a licensed payment aggregator (RBI PA guidelines), so it should only collect money for
  the merchant who owns the receiving account, never for third parties.
- For a client such as Biotane, get their written acknowledgement of the above, or use a licensed
  gateway (Razorpay, Cashfree, PayU), which provide UPI with server-side confirmation.

### Residual technical risks
- Matching is by amount and time on one VPA. If someone else sends the exact same amount to the
  merchant's VPA during an active window, it can be attributed to the waiting session.
- SMS sender IDs are trusted after DLT-style format checks. International SMS spoofing of
  alphanumeric senders is rare but possible.
- `GET /api/v1/payments/:id` and the checkout routes are public. The unguessable session UUID acts
  as the capability, as in most hosted checkouts.
