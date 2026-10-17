import '@shopify/ui-extensions/preact';
import { useEffect, useState } from 'preact/hooks';

/**
 * Shows "Pay with UPI" for orders placed with the YouPI manual payment method.
 * The bridge decides everything server-side (amount from Shopify, whether the order uses YouPI);
 * this component only renders its answer.
 *
 * @param {{ orderId: string | undefined }} props Shopify order GID (Order or OrderIdentity)
 */
export function PayWithUpi({ orderId }) {
  const [result, setResult] = useState({ loading: true });

  useEffect(() => {
    let cancelled = false;

    async function load() {
      const bridgeUrl = String(shopify.settings.value.bridge_url || '').replace(/\/+$/, '');
      if (!bridgeUrl || !orderId) {
        setResult({ state: 'NOT_APPLICABLE' });
        return;
      }
      try {
        const token = await shopify.sessionToken.get();
        const res = await fetch(`${bridgeUrl}/api/extension/payment`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ orderId })
        });
        const data = await res.json();
        if (!cancelled) setResult(res.ok ? data : { error: true });
      } catch {
        if (!cancelled) setResult({ error: true });
      }
    }

    load();
    return () => { cancelled = true; };
  }, [orderId]);

  if (result.loading) {
    return <s-spinner accessibilityLabel="Loading payment details" />;
  }

  if (result.error) {
    return (
      <s-banner tone="critical" heading="We couldn't load your UPI payment">
        <s-text>Please refresh this page. If it keeps happening, contact the store with your order number.</s-text>
      </s-banner>
    );
  }

  if (result.state === 'PAID') {
    return (
      <s-banner tone="success" heading="UPI payment received">
        <s-text>Thank you! Your payment is confirmed.</s-text>
      </s-banner>
    );
  }

  if (result.state === 'PAY') {
    return (
      <s-banner tone="warning" heading="Complete your UPI payment">
        <s-stack gap="base">
          <s-text>Your order is placed but not paid yet. Pay ₹{result.amount} with any UPI app to confirm it.</s-text>
          <s-button variant="primary" href={result.checkoutUrl} target="_blank">
            Pay ₹{result.amount} with UPI
          </s-button>
          <s-text color="subdued">This page updates once the payment is verified (usually within a minute).</s-text>
        </s-stack>
      </s-banner>
    );
  }

  return null;
}
