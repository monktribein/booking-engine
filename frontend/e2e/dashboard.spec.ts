import { expect, test } from '@playwright/test';
import { day, signedIn, appAlert } from './helpers';

test.describe('dashboard', () => {
  test.beforeEach(async ({ page }) => {
    await signedIn(page);
  });

  test('loads the real property, stats, channels and reservations', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: 'Radha Ashram' })).toBeVisible();
    await expect(page.getByText('Total Rooms')).toBeVisible();
    await expect(page.getByText('Mock OTA')).toBeVisible();
    await expect(page.getByText(/^TRV-/).first()).toBeVisible();
  });

  test('a failing API shows an error with retry, not sample numbers; retry recovers', async ({ page }) => {
    let fail = true;
    await page.route('**/reports/occupancy*', (route) =>
      fail ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ success: false, error: { code: 'INTERNAL_ERROR', message: 'stack trace /srv/secret.js' } }) }) : route.continue()
    );
    await page.goto('/dashboard');
    const alert = appAlert(page).filter({ hasText: /server error/i });
    await expect(alert).toBeVisible();
    await expect(page.getByText('Total Rooms')).toHaveCount(0); // no stat cards, hence no fabricated numbers
    await expect(page.getByText('secret.js')).toHaveCount(0); // server internals are never shown
    fail = false;
    await alert.getByRole('button', { name: /try again/i }).click();
    await expect(page.getByText('Total Rooms')).toBeVisible();
  });

  test('the reservations list is not replaced by sample data when the API is down', async ({ page }) => {
    await page.route('**/reservations?*', (route) => route.abort('connectionrefused'));
    await page.goto('/dashboard/reservations');
    await expect(appAlert(page)).toContainText(/cannot reach the server/i);
    await expect(page.getByText(/^TRV-/)).toHaveCount(0);
  });

  test('a 403 is reported as "not allowed", not as an empty table', async ({ page }) => {
    await page.goto('/dashboard/channels/sync-logs');
    await expect(appAlert(page)).toContainText(/not allowed/i);
    await expect(page.getByText('No sync errors')).toHaveCount(0);
  });

  test('creates a reservation through the form and finds it in the list', async ({ page }) => {
    const name = `E2E${Date.now().toString(36)}`;
    await page.goto('/dashboard/reservations');
    await page.getByRole('button', { name: /new reservation/i }).click();
    const dialog = page.getByRole('dialog').or(page.locator('form').filter({ hasText: 'Create New Reservation' }));
    await page.getByLabel('First Name *').fill(name);
    await page.getByLabel('Last Name').fill('Tester');
    await page.getByLabel(/Phone Number/).fill('+919800012345');
    await page.getByLabel('Check-in Date *').fill(day(3));
    await page.getByLabel('Check-out Date *').fill(day(5));
    await expect(page.getByLabel('Rate Plan *')).not.toBeDisabled();
    await page.getByRole('button', { name: /confirm & reserve/i }).click();
    await expect(dialog).toHaveCount(0);
    await page.getByLabel('Search reservations').fill(name);
    await expect(page.getByText(`${name} Tester`)).toBeVisible();
  });

  test('a rejected reservation keeps the typed values and shows the server message', async ({ page }) => {
    await page.goto('/dashboard/reservations');
    await page.getByRole('button', { name: /new reservation/i }).click();
    await page.getByLabel('First Name *').fill('Keepme');
    await page.getByLabel('Check-in Date *').fill(day(3));
    await page.getByLabel('Check-out Date *').fill(day(5));
    await page.getByLabel(/Phone Number/).fill('98000 12345'); // missing +country code -> server validation error
    await page.getByRole('button', { name: /confirm & reserve/i }).click();
    await expect(appAlert(page).filter({ hasText: /phone/i })).toBeVisible();
    await expect(page.getByLabel('First Name *')).toHaveValue('Keepme');
  });
});
