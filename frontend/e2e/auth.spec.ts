import { expect, test } from '@playwright/test';
import { OWNER, signedIn, signInThroughTheForm, appAlert } from './helpers';

test.describe('authentication', () => {
  test('wrong password: backend message, stays on /login, no session stored', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Email Address').fill(OWNER.email);
    await page.getByLabel('Password', { exact: true }).fill('definitely-wrong-1');
    await page.getByRole('button', { name: /sign in to dashboard/i }).click();
    await expect(appAlert(page)).toContainText(/invalid/i);
    await expect(page).toHaveURL(/\/login$/);
    expect(await page.evaluate(() => [localStorage.getItem('tirvona_at'), localStorage.getItem('tirvona_rt')])).toEqual([null, null]);
    await expect(page.getByLabel('Email Address')).toHaveValue(OWNER.email); // kept for the retry
  });

  test('the "demo" e-mail with a made-up password is NOT signed in', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Email Address').fill('owner@tirvona.demo');
    await page.getByLabel('Password', { exact: true }).fill('password123');
    await page.getByRole('button', { name: /sign in to dashboard/i }).click();
    await expect(appAlert(page)).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);
  });

  test('backend unreachable: a connection error, never a fake session', async ({ page }) => {
    await page.route('**/auth/login', (route) => route.abort('connectionrefused'));
    await page.goto('/login');
    await page.getByLabel('Email Address').fill('owner@tirvona.demo');
    await page.getByLabel('Password', { exact: true }).fill('anything-1234');
    await page.getByRole('button', { name: /sign in to dashboard/i }).click();
    await expect(appAlert(page)).toContainText(/cannot reach the server/i);
    await expect(page).toHaveURL(/\/login$/);
    expect(await page.evaluate(() => localStorage.getItem('tirvona_at'))).toBeNull();
  });

  test('valid login reaches the dashboard with the real property; sign out returns to /login and clears the session', async ({ page }) => {
    await signInThroughTheForm(page);
    await expect(page.getByRole('heading', { name: 'Radha Ashram' })).toBeVisible();
    await page.getByTitle('Sign Out').click();
    await expect(page).toHaveURL(/\/login$/);
    expect(await page.evaluate(() => localStorage.getItem('tirvona_rt'))).toBeNull();
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/login$/); // and it stays protected
  });
});

test.describe('protected routes and expired sessions', () => {
  test('/dashboard without a session redirects to /login', async ({ page }) => {
    await page.goto('/dashboard/reservations');
    await expect(page).toHaveURL(/\/login$/);
  });

  test('both tokens invalid: redirected to /login and the dead tokens are removed', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('tirvona_at', 'not.a.jwt');
      localStorage.setItem('tirvona_rt', 'x'.repeat(40));
    });
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/login$/);
    expect(await page.evaluate(() => [localStorage.getItem('tirvona_at'), localStorage.getItem('tirvona_rt')])).toEqual([null, null]);
  });

  test('expired access token + valid refresh token: the page loads and the tokens rotate silently', async ({ page }) => {
    const t = await signedIn(page, { accessToken: 'expired.access.token' });
    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: 'Radha Ashram' })).toBeVisible();
    const stored = await page.evaluate(() => [localStorage.getItem('tirvona_at'), localStorage.getItem('tirvona_rt')]);
    expect(stored[0]).not.toBe('expired.access.token');
    expect(stored[1]).not.toBe(t.refreshToken); // rotated
  });
});
