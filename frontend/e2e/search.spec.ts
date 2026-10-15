import { expect, test } from '@playwright/test';
import { day, fakeRazorpayCheckout, SLUG } from './helpers';

/** The guest journey from a destination search to the booking summary, in a real browser against the real API. */
test.describe('guest property search', () => {
  test('lists the property with its real from-price, and a search that matches nothing says so', async ({ page }) => {
    await page.goto('/stays');
    const card = page.getByRole('link', { name: /Radha Ashram/ });
    await expect(card).toBeVisible();
    await expect(card).toContainText('Vrindavan, Uttar Pradesh');
    await expect(card).toContainText('₹');
    await expect(page.getByText(/\d+ stays? found/)).toBeVisible();

    await page.getByLabel('Where to?').fill('no-such-destination-zzz');
    await page.getByRole('button', { name: /^search$/i }).click();
    await expect(page).toHaveURL(/q=no-such-destination-zzz/);
    await expect(page.getByText('No stays match your search')).toBeVisible();

    await page.getByRole('button', { name: 'Clear' }).click();
    await expect(page.getByRole('link', { name: /Radha Ashram/ })).toBeVisible();
  });

  test('searching with dates prices the stay and carries the dates into the property page and on to checkout', async ({ page }) => {
    await fakeRazorpayCheckout(page, () => 'success');
    await page.goto('/stays');
    await page.getByLabel('Where to?').fill('vrindavan');
    await page.getByLabel('Check-in').fill(day(12));
    await page.getByLabel('Check-out').fill(day(14));
    await page.getByRole('button', { name: /^search$/i }).click();
    await expect(page).toHaveURL(new RegExp(`checkIn=${day(12)}&checkOut=${day(14)}`));

    const card = page.getByRole('link', { name: /Radha Ashram/ });
    await expect(card).toContainText('total');
    await expect(card).toContainText('for 2 nights');
    await card.click();

    await expect(page).toHaveURL(new RegExp(`/stays/${SLUG}\\?checkIn=${day(12)}&checkOut=${day(14)}`));
    await expect(page.locator('#bs-checkin')).toHaveValue(day(12));
    await expect(page.locator('#bs-checkout')).toHaveValue(day(14));
    await page.getByRole('button', { name: /book now/i }).first().click();
    await expect(page).toHaveURL(new RegExp(`/booking/${SLUG}\\?`));
    await expect(page.getByText('Booking Summary')).toBeVisible();
  });

  test('a price cap below the property\'s rate returns nothing, and the filters survive a reload', async ({ page }) => {
    await page.goto('/stays?maxPrice=100&amenities=wifi');
    await expect(page.getByText('No stays match your search')).toBeVisible();
    await page.reload();
    await expect(page.getByText('No stays match your search')).toBeVisible();
    await page.getByText('Filters and sorting').click(); // a <details> summary
    await expect(page.getByLabel('WiFi')).toBeChecked();
  });

  test('the landing page links to the real search, not to a hard-coded property', async ({ page }) => {
    await page.goto('/');
    const hrefs = await page.locator('a[href^="/stays"]').evaluateAll((els) => els.map((e) => e.getAttribute('href')));
    expect(hrefs.length).toBeGreaterThan(0);
    expect(hrefs.every((h) => h === '/stays')).toBe(true);
  });
});
