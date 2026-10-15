import { createHmac } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';
import { RazorpayProvider } from './razorpay.provider';

const cfg = { keyId: 'rzp_test_1', keySecret: 'secret_1', webhookSecret: 'whsec_1' };
const provider = new RazorpayProvider({ get: () => cfg } as unknown as ConfigService<never, true>);

describe('RazorpayProvider signatures', () => {
  it('verifies the Checkout signature HMAC(order_id|payment_id, key_secret)', () => {
    const sig = createHmac('sha256', 'secret_1').update('order_A|pay_B').digest('hex');
    expect(provider.verifyPaymentSignature({ orderId: 'order_A', paymentId: 'pay_B', signature: sig })).toBe(true);
    expect(provider.verifyPaymentSignature({ orderId: 'order_A', paymentId: 'pay_C', signature: sig })).toBe(false);
    expect(provider.verifyPaymentSignature({ orderId: 'order_A', paymentId: 'pay_B', signature: 'zz' })).toBe(false);
  });

  it('verifies webhooks over the exact raw body', () => {
    const raw = Buffer.from('{"event":"payment.captured"}');
    const sig = createHmac('sha256', 'whsec_1').update(raw).digest('hex');
    expect(provider.verifyWebhookSignature(raw, sig)).toBe(true);
    expect(provider.verifyWebhookSignature(Buffer.from('{"event": "payment.captured"}'), sig)).toBe(false); // re-serialised body fails
    expect(provider.verifyWebhookSignature(raw, undefined)).toBe(false);
  });

  it('normalises webhook payloads', () => {
    const e = provider.parseWebhook(
      { event: 'payment.captured', payload: { payment: { entity: { id: 'pay_1', order_id: 'order_1', amount: 5000, currency: 'INR', method: 'upi' } } } },
      { 'x-razorpay-event-id': 'evt_1' },
    );
    expect(e).toMatchObject({ type: 'PAYMENT_CAPTURED', eventId: 'evt_1', orderId: 'order_1', paymentId: 'pay_1', amount: 5000 });
    expect(provider.parseWebhook({ event: 'refund.processed', payload: { refund: { entity: { id: 'rfnd_1', payment_id: 'pay_1', amount: 100 } } } }, {}).type).toBe('REFUND_PROCESSED');
  });
});
