/**
 * Thin wrapper around the official Razorpay Checkout (https://checkout.razorpay.com/v1/checkout.js).
 *
 * Security notes:
 * - Only the PUBLIC key id and the server-created order id are used here. The key secret never reaches the browser.
 * - The `handler` callback is NOT proof of payment. Callers must send the three returned values to
 *   POST /payments/verify, where the server checks the signature before capturing.
 */
import type { CheckoutParams } from '@/types';

export const CHECKOUT_SCRIPT_URL = 'https://checkout.razorpay.com/v1/checkout.js';

export interface RazorpaySuccess {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
}

export interface RazorpayFailure {
  error?: { code?: string; description?: string; reason?: string };
}

interface RazorpayInstance {
  open(): void;
  on(event: 'payment.failed', cb: (res: RazorpayFailure) => void): void;
}
type RazorpayCtor = new (options: Record<string, unknown>) => RazorpayInstance;

declare global {
  interface Window {
    Razorpay?: RazorpayCtor;
  }
}

let scriptPromise: Promise<RazorpayCtor> | null = null;

/** Loads checkout.js once. Rejects (and allows a later retry) if the script cannot be loaded. */
export function loadRazorpayScript(): Promise<RazorpayCtor> {
  if (typeof window === 'undefined') return Promise.reject(new Error('Razorpay Checkout needs a browser'));
  if (window.Razorpay) return Promise.resolve(window.Razorpay);
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise<RazorpayCtor>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = CHECKOUT_SCRIPT_URL;
    s.async = true;
    s.onload = () => (window.Razorpay ? resolve(window.Razorpay) : reject(new Error('Razorpay Checkout failed to initialise')));
    s.onerror = () => {
      scriptPromise = null; // allow retry
      s.remove();
      reject(new Error('Could not load the payment window. Check your connection and try again.'));
    };
    document.head.appendChild(s);
  });
  return scriptPromise;
}

export interface CheckoutCallbacks {
  onSuccess: (res: RazorpaySuccess) => void;
  /** The guest closed the window without paying. The order stays open until the hold expires. */
  onDismiss: () => void;
  onFailure: (message: string) => void;
}

export async function openRazorpayCheckout(params: CheckoutParams, name: string, cb: CheckoutCallbacks): Promise<void> {
  const Razorpay = await loadRazorpayScript();
  const rzp = new Razorpay({
    key: params.keyId,
    order_id: params.orderId,
    amount: params.amount,
    currency: params.currency,
    name,
    description: `Booking ${params.reservationCode}`,
    prefill: params.prefill,
    handler: (res: RazorpaySuccess) => cb.onSuccess(res),
    modal: { ondismiss: () => cb.onDismiss(), escape: true },
  });
  rzp.on('payment.failed', (res) => cb.onFailure(res.error?.description || 'The payment could not be completed.'));
  rzp.open();
}
