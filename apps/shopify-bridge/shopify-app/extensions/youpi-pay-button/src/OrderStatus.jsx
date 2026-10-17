import '@shopify/ui-extensions/preact';
import { render } from 'preact';
import { PayWithUpi } from './PayWithUpi.jsx';

export default async () => {
  render(<PayWithUpi orderId={shopify.order.value?.id} />, document.body);
};
