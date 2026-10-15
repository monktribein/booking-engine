import { apiClient } from './client';
import { Payment } from '@/types';

export interface VerifyPaymentInput {
  razorpayOrderId: string;
  razorpayPaymentId: string;
  razorpaySignature: string;
}

export const paymentsApi = {
  /**
   * Guest browser callback after Razorpay Checkout. The server re-computes the HMAC signature and only then
   * captures the payment; the client's own success flag is never trusted. Public endpoint (no auth header).
   */
  verifyCheckout(input: VerifyPaymentInput): Promise<{ payment: Payment; reservation: { reservationCode: string; status: string; paymentStatus: string } | null }> {
    return apiClient('/payments/verify', { method: 'POST', body: JSON.stringify(input), skipAuth: true });
  },

  /** Backend contract: payments are listed per reservation (GET /payments?reservationId=). */
  listForReservation(reservationId: string): Promise<Payment[]> {
    return apiClient<Payment[]>('/payments', { params: { reservationId } });
  },

  get(id: string): Promise<Payment> {
    return apiClient<Payment>(`/payments/${id}`);
  },

  recordPayment(payload: {
    reservationId: string;
    amount?: number;
    provider: string;
    reference?: string;
  }): Promise<{ payment: Payment; checkout: unknown | null }> {
    return apiClient<{ payment: Payment; checkout: unknown | null }>('/payments/create', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  refund(id: string, payload: { amount?: number; reason: string }): Promise<unknown> {
    return apiClient<unknown>(`/payments/${id}/refund`, { method: 'POST', body: JSON.stringify(payload) });
  },
};
