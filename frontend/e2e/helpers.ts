import { createHmac } from 'node:crypto';
import { expect, Page } from '@playwright/test';

/** The app's own alert (Next.js also renders an empty role=alert route announcer, which getByRole('alert') would match too). */
export const appAlert = (page: Page) => page.locator('[role=alert]:not(#__next-route-announcer__)');

export const API = process.env.E2E_API_URL ?? 'http://localhost:3000';
export const OWNER = { email: process.env.E2E_OWNER_EMAIL ?? 'owner@tirvona.demo', password: process.env.E2E_OWNER_PASSWORD ?? 'SandboxPass-123' };
export const SLUG = process.env.E2E_PROPERTY_SLUG ?? 'radha-ashram';

// Fixed credentials of the sandbox gateway (scripts/dev-sandbox.ts). Never real keys.
const SANDBOX_KEY_SECRET = process.env.E2E_RAZORPAY_KEY_SECRET ?? 'sandbox_key_secret_value';
export const sign = (orderId: string, paymentId: string) => createHmac('sha256', SANDBOX_KEY_SECRET).update(`${orderId}|${paymentId}`).digest('hex');

/** YYYY-MM-DD, n days from today (local). */
export function day(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Starts the page already signed in (fast path for tests that are not about the login form). It signs in through the app's own
 * session endpoint, exactly like the login form, so the browser receives the HttpOnly refresh-token cookie; the page then turns it
 * into an in-memory access token on load. Nothing is written to localStorage.
 */
export async function signedIn(page: Page, email = OWNER.email, password = OWNER.password) {
  const res = await page.request.post('/api/session/login', { headers: { 'x-tirvona-csrf': '1' }, data: { email, password } });
  if (!res.ok()) throw new Error(`login failed: ${res.status()}`);
  return (await res.json()).data as { accessToken: string; expiresIn: number };
}

/** The refresh-token cookie as the browser holds it, or undefined. */
export async function refreshCookie(page: Page) {
  return (await page.context().cookies()).find((c) => /^(__Secure-)?tv_rt$/.test(c.name));
}

export async function signInThroughTheForm(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email Address').fill(OWNER.email);
  await page.getByLabel('Password', { exact: true }).fill(OWNER.password);
  await page.getByRole('button', { name: /sign in to dashboard/i }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}

export type RazorpayMode = 'success' | 'dismiss' | 'fail' | 'forged';

/**
 * Replaces https://checkout.razorpay.com/v1/checkout.js with a controllable stand-in, so no real payment window opens
 * and no card is ever involved. 'success' answers with a signature computed from the sandbox secret, exactly the way the
 * real Checkout hands one back; 'forged' sends a wrong signature to prove the server rejects it.
 */
export async function fakeRazorpayCheckout(page: Page, mode: () => RazorpayMode) {
  await page.exposeFunction('__rzpSign', (orderId: string, paymentId: string) => (mode() === 'forged' ? 'f'.repeat(64) : sign(orderId, paymentId)));
  await page.exposeFunction('__rzpMode', () => mode());
  await page.route('https://checkout.razorpay.com/v1/checkout.js', (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body: `
        window.__rzpOpened = (window.__rzpOpened || 0);
        window.Razorpay = function (opts) {
          this.opts = opts; this.failCb = null;
          window.__rzpLastOrder = opts.order_id;
        };
        window.Razorpay.prototype.on = function (ev, cb) { if (ev === 'payment.failed') this.failCb = cb; };
        window.Razorpay.prototype.open = function () {
          var self = this; window.__rzpOpened++;
          window.__rzpMode().then(function (m) {
            if (m === 'dismiss') return self.opts.modal.ondismiss();
            if (m === 'fail') return self.failCb({ error: { description: 'Your bank declined the payment' } });
            var pid = 'pay_E2E' + Date.now();
            window.__rzpSign(self.opts.order_id, pid).then(function (sig) {
              self.opts.handler({ razorpay_order_id: self.opts.order_id, razorpay_payment_id: pid, razorpay_signature: sig });
            });
          });
        };`,
    })
  );
}
