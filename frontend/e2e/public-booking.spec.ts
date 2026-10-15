import { expect, Page, test } from '@playwright/test';
import { day, fakeRazorpayCheckout, RazorpayMode, SLUG, appAlert } from './helpers';

let mode: RazorpayMode = 'success';

async function startCheckout(page: Page, offset: number) {
  await page.goto(`/stays/${SLUG}`);
  await page.locator('#bs-checkin').fill(day(offset));
  await page.locator('#bs-checkout').fill(day(offset + 2));
  await page.getByRole('button', { name: /check availability/i }).click();
  await page.getByRole('button', { name: /book now/i }).first().click();
  await expect(page).toHaveURL(new RegExp(`/booking/${SLUG}\\?`));
  await expect(page.getByText('Booking Summary')).toBeVisible();
}

async function fillGuest(page: Page, email: string) {
  await page.getByLabel('First Name *').fill('Priya');
  await page.getByLabel('Last Name *').fill('Sharma');
  await page.getByLabel(/Phone/).fill('+91 98765 43210');
  await page.getByLabel('Email *').fill(email);
}

test.describe('public booking + payment (sandbox gateway, no real charge)', () => {
  test.beforeEach(async ({ page }) => {
    mode = 'success';
    await fakeRazorpayCheckout(page, () => mode);
  });

  test('property page is server-rendered from the backend; unknown property is a 404', async ({ page }) => {
    const res = await page.goto(`/stays/${SLUG}`);
    expect(res?.status()).toBe(200);
    await expect(page.getByRole('heading', { name: 'Radha Ashram' })).toBeVisible();
    expect((await page.goto('/stays/no-such-hotel'))?.status()).toBe(404);
  });

  test('search -> hold -> pay -> server verifies -> confirmation shows a CONFIRMED booking', async ({ page }) => {
    const email = `e2e.success.${Date.now()}@example.com`;
    await startCheckout(page, 24);
    await fillGuest(page, email);
    await page.getByRole('button', { name: /reserve & pay/i }).click();
    await expect(page).toHaveURL(new RegExp(`/booking/${SLUG}/confirmation\\?code=TRV-`));
    await expect(page.getByRole('heading', { name: 'Booking Confirmed' })).toBeVisible();
    await expect(page.getByText(/PAID/)).toBeVisible();
    // the lookup page agrees (independent read of the same booking)
    const code = new URL(page.url()).searchParams.get('code')!;
    await page.goto('/booking/lookup');
    await page.getByLabel(/booking code/i).fill(code);
    await page.getByLabel(/email/i).fill(email);
    await page.getByRole('button', { name: /lookup booking/i }).click();
    await expect(page.getByText('CONFIRMED')).toBeVisible();
  });

  test('closing the payment window keeps the hold; "Pay now" completes it with the same booking', async ({ page }) => {
    mode = 'dismiss';
    await startCheckout(page, 8);
    await fillGuest(page, `e2e.dismiss.${Date.now()}@example.com`);
    await page.getByRole('button', { name: /reserve & pay/i }).click();
    await expect(page.getByText(/payment was not completed/i)).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/booking/${SLUG}\\?`)); // still on checkout
    mode = 'success';
    await page.getByRole('button', { name: /pay now/i }).click();
    await expect(page.getByRole('heading', { name: 'Booking Confirmed' })).toBeVisible();
  });

  test('a declined payment shows the gateway message and does not confirm', async ({ page }) => {
    mode = 'fail';
    await startCheckout(page, 12);
    await fillGuest(page, `e2e.fail.${Date.now()}@example.com`);
    await page.getByRole('button', { name: /reserve & pay/i }).click();
    await expect(page.getByText(/bank declined/i)).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/booking/${SLUG}\\?`));
  });

  test('a forged payment signature is rejected by the server and the booking stays unpaid', async ({ page }) => {
    mode = 'forged';
    await startCheckout(page, 15);
    await fillGuest(page, `e2e.forged.${Date.now()}@example.com`);
    await page.getByRole('button', { name: /reserve & pay/i }).click();
    await expect(page.getByText(/could not confirm your payment/i)).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/booking/${SLUG}\\?`)); // never reaches confirmation
    await expect(page.getByRole('button', { name: /retry confirmation/i })).toBeVisible();
  });

  test('reserving twice quickly creates one booking (idempotent submit)', async ({ page }) => {
    const reservations: string[] = [];
    page.on('request', (r) => {
      if (r.method() === 'POST' && r.url().endsWith('/public/reservations')) reservations.push(r.url());
    });
    await startCheckout(page, 18);
    await fillGuest(page, `e2e.double.${Date.now()}@example.com`);
    await page.getByRole('button', { name: /reserve & pay/i }).dblclick();
    await expect(page.getByRole('heading', { name: 'Booking Confirmed' })).toBeVisible();
    expect(reservations).toHaveLength(1);
  });

  test('the server being down during search shows an error, not made-up rooms', async ({ page }) => {
    await page.route('**/public/properties/*/availability*', (route) => route.abort('connectionrefused'));
    await page.goto(`/stays/${SLUG}`);
    await expect(appAlert(page)).toContainText(/cannot reach the server/i);
    await expect(page.getByRole('button', { name: /book now/i })).toHaveCount(0);
  });
});
