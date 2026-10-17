# Shopify Integration (YouPI Bridge)

This connects a Shopify store to YOUPI PG so customers can pay for orders by UPI, and orders are
marked **Paid** in Shopify automatically once the bank credit is verified.

> **Read [SECURITY_REVIEW.md](./SECURITY_REVIEW.md) first.** It covers the licence and RBI/bank
> compliance questions. Neither is a code problem, and both need answers before this handles a
> client's revenue.

## How it works

Shopify only lets approved Payments Partners add a payment gateway inside checkout. Everyone else
uses a **manual payment method**, which is what this bridge builds on:

```
Customer checkout ──► picks "UPI (YouPI)" (manual payment method) ──► order created, status Pending
        │
        ├─► Shopify webhook orders/create ──► bridge reads the order from the Admin API
        │                                      └─► creates a YOUPI payment for the order's outstanding
        │                                          INR balance (server-side, secret key)
        │
        ├─► Thank-you page / order status page: "Pay ₹499.00 with UPI" button (UI extension)
        │     └─► opens YOUPI checkout (QR / UPI intent)
        │
        └─► bank SMS / Gmail credit observed ──► YOUPI SUCCESS webhook (HMAC-signed) ──► bridge
              └─► re-checks the order in Shopify, the amount and the currency
                  └─► orderMarkAsPaid + tag "youpi-paid" + metafields youpi.utr / youpi.payment_id
```

The bridge never trusts amounts from the browser. The amount always comes from Shopify. An order
is marked paid only when all of these hold:

1. The YOUPI webhook signature verifies over the raw body.
2. The paid amount equals what the bridge asked YOUPI to collect.
3. That amount still equals the order's outstanding balance in Shopify, and the order is not cancelled.

If any check fails, the order is left unpaid and flagged `NEEDS_REVIEW` in the bridge store
(`data/shopify-bridge.json`) and in the logs, so you can reconcile or refund by hand.

Orders are mapped by `metadata.shopify_order_id`. A YOUPI retry renames the internal order ID
(`SHOPIFY-1001-R4821`), so the bridge never maps by `orderId`.

## 1. Run YOUPI PG with authentication on

From the repo root:

```bash
cp .env.example .env      # leave the YOUPI_* secrets empty to auto-generate them
npm install
npm start                 # or your existing deployment
cat data/.youpi-secrets.json   # adminPassword, merchantSecretKey, ...
```

- Sign in to Merchant Admin (`:6001`) with `adminPassword`.
- Set the receiving UPI ID, then connect the SMS gateway and Gmail observers as before.
- Under webhook settings, set the URL to `https://<SHOPIFY_BRIDGE_URL>/youpi/webhook` and choose a
  long random webhook secret. You'll use the same secret as `YOUPI_WEBHOOK_SECRET` in step 4.
- Confirm `YOUPI_ENABLE_DEV_TOOLS=false` and `YOUPI_ALLOW_PUBLIC_PAYMENT_CREATE=false` in production.

## 2. Create the manual payment method in Shopify

Shopify Admin → **Settings → Payments → Manual payment methods → Create custom payment method**:

- **Name:** `UPI (YouPI)`. It must match `SHOPIFY_PAYMENT_METHOD_NAME` exactly.
- **Additional details:** "Pay instantly with any UPI app after placing your order."
- **Payment instructions:** "Click *Pay with UPI* on the next page. Your order is confirmed once payment is verified."

## 3. Create the Shopify app

The bridge needs Admin API access with the `read_orders` and `write_orders` scopes. Use either option.

**Option A (recommended): an app from the Shopify Dev Dashboard, installed with OAuth.**

1. In the Shopify Dev Dashboard (dev.shopify.com), create an app.
2. Use **custom distribution** and select your store.
3. In `apps/shopify-bridge/shopify-app/shopify.app.toml`, replace `bridge.example.com` with your
   bridge URL and set `client_id`.
4. Copy the **Client ID** into `SHOPIFY_API_KEY` and the **Client secret** into `SHOPIFY_API_SECRET`.

**Option B: you already have an Admin API access token** (an existing custom app). Put it in
`SHOPIFY_ADMIN_ACCESS_TOKEN`, and the app's API secret in `SHOPIFY_API_SECRET`. The secret is still
needed to verify webhooks. Then register the two webhooks yourself (see step 5).

## 4. Configure and start the bridge

The bridge must be reachable over **public HTTPS**, for example a Cloudflare Tunnel hostname such as
`https://shopify-bridge.yourdomain.com`. Set these in `.env`:

```bash
SHOPIFY_BRIDGE_URL=https://shopify-bridge.yourdomain.com
SHOPIFY_SHOP_DOMAIN=your-store.myshopify.com
SHOPIFY_API_KEY=...
SHOPIFY_API_SECRET=...
YOUPI_API_URL=http://localhost:6100            # internal URL of the payment API
YOUPI_MERCHANT_SECRET_KEY=sk_live_...          # from data/.youpi-secrets.json, or rotate a dedicated one
YOUPI_WEBHOOK_SECRET=...                       # same secret as Merchant Admin webhook settings
```

```bash
npm run start:shopify-bridge
curl https://shopify-bridge.yourdomain.com/health
```

A dedicated key for the bridge can be issued (the key is shown only once):

```bash
curl -X POST http://localhost:6100/api/v1/admin/api-keys/rotate -H "Authorization: Bearer <adminToken>"
```

## 5. Install the app on the store

For Option A, open `https://shopify-bridge.yourdomain.com/shopify/install` and approve the install.
The bridge stores the offline token in `data/shopify-bridge.json` (mode 600) and registers the
`orders/create` and `app/uninstalled` webhooks.

For Option B, register them with `shopify app deploy` (the toml lists them) or in the admin:

- `orders/create` → `https://shopify-bridge.yourdomain.com/shopify/webhooks/orders-create`
- `app/uninstalled` → `https://shopify-bridge.yourdomain.com/shopify/webhooks/app-uninstalled`

## 6. Add the "Pay with UPI" button to the thank-you and order status pages

`apps/shopify-bridge/shopify-app/extensions/youpi-pay-button` is a UI extension (Preact + Polaris
web components) for `purchase.thank-you.block.render` and `customer-account.order-status.block.render`.

```bash
cd apps/shopify-bridge/shopify-app
npm install
npx shopify app dev       # test on a development store
npx shopify app deploy    # release
```

Then:

1. In the Dev Dashboard, request **network access** for the app's UI extensions. The button calls the bridge.
2. In the store: **Settings → Checkout → Customize**. Switch to the *Thank you* page, add the
   **YouPI pay button** block, and set **YouPI bridge URL** to your bridge URL. Repeat on the
   *Order status* page.

The extension sends a Shopify session token. The bridge checks its signature, audience, expiry, and
shop before it reveals or creates a payment.

**Fallback without the extension:** for every YouPI order, the bridge saves a signed pay link in the
order metafield `youpi.pay_url`. Staff can copy it from the order page and send it to the customer.
You can also add it to notification templates as `{{ order.metafields.youpi.pay_url }}`. This works
for templates sent after the order is created, such as reminders; the order confirmation email can
go out before the link exists.

## 7. Test before going live

1. Place a test order with a small amount (₹1), choosing **UPI (YouPI)**.
2. On the thank-you page, click **Pay ₹1.00 with UPI**, sign in on the YouPI checkout, and pay from a
   real UPI app.
3. Within about a minute the order should show **Paid**, tagged `youpi-paid`, with metafield `youpi.utr`.
4. Check `data/shopify-bridge.json` for no `NEEDS_REVIEW` entries.

The automated suite covers the same flow against a mocked Shopify Admin API:
`node --test apps/shopify-bridge/src/__tests__/shopify-bridge.test.js`.

## Operational notes and limits

- **INR only.** Orders in other currencies are skipped (`CURRENCY_NOT_INR`).
- **One payer per UPI ID at a time.** Each payment holds the receiving VPA for up to 5 minutes, so
  during a sale customers queue. See SECURITY_REVIEW.md → "Throughput".
- **Unpaid orders stay Pending.** Shopify does not cancel them. Use an automation (Shopify Flow) to
  cancel unpaid YouPI orders after N hours; until an order is cancelled, its pay link keeps working.
- **Refunds** are manual (UPI transfer back). Record them in Shopify as usual.
- **Order edits** after payment creation change the outstanding amount. The bridge then flags the
  payment instead of marking the order paid.
- **The extension was not tested against a live store in this change.** The bridge's server side is
  covered by tests. Run `shopify app dev` on a development store before launch, and pin the
  `@shopify/ui-extensions` version that `shopify app generate extension` gives you if the one in
  `package.json` differs.
