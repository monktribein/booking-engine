import { expect, test } from '@playwright/test';
import { OWNER, refreshCookie, signedIn, signInThroughTheForm, appAlert } from './helpers';

test.describe('authentication', () => {
  test('wrong password: backend message, stays on /login, no session stored', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Email Address').fill(OWNER.email);
    await page.getByLabel('Password', { exact: true }).fill('definitely-wrong-1');
    await page.getByRole('button', { name: /sign in to dashboard/i }).click();
    await expect(appAlert(page)).toContainText(/invalid/i);
    await expect(page).toHaveURL(/\/login$/);
    expect(await page.evaluate(() => [localStorage.getItem('tirvona_at'), localStorage.getItem('tirvona_rt')])).toEqual([null, null]);
    expect(await refreshCookie(page)).toBeUndefined(); // a failed login sets no session cookie
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
    await page.route('**/api/session/login', (route) => route.abort('connectionrefused'));
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
    expect(await refreshCookie(page)).toBeTruthy();
    await page.getByTitle('Sign Out').click();
    await expect(page).toHaveURL(/\/login$/);
    expect(await refreshCookie(page)).toBeUndefined(); // the cookie is gone, the session is revoked on the API
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

  test('a garbage session cookie: redirected to /login and the dead cookie is removed', async ({ page, context, baseURL }) => {
    const url = new URL(baseURL!);
    await context.addCookies([
      { name: 'tv_rt', value: 'x'.repeat(40), domain: url.hostname, path: '/api/session', httpOnly: true, sameSite: 'Strict' },
      { name: 'tv_s', value: '1', domain: url.hostname, path: '/' },
    ]);
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/login$/);
    expect(await refreshCookie(page)).toBeUndefined();
  });

  test('a reload keeps you signed in: the access token is only in memory, the cookie renews it and rotates', async ({ page }) => {
    await signedIn(page);
    const before = (await refreshCookie(page))!.value;
    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: 'Radha Ashram' })).toBeVisible();
    const after = (await refreshCookie(page))!.value;
    expect(after).not.toBe(before); // single-use refresh tokens rotate on every restore
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Radha Ashram' })).toBeVisible();
  });

  test('the refresh token is unreachable from page JavaScript (HttpOnly), and nothing secret is in localStorage', async ({ page }) => {
    await signedIn(page);
    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: 'Radha Ashram' })).toBeVisible();
    const seen = await page.evaluate(() => ({ cookie: document.cookie, storage: JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }) }));
    expect(seen.cookie).not.toMatch(/tv_rt/);
    expect(seen.storage).not.toMatch(/eyJ|refresh|tirvona_rt|tirvona_at/);
    const cookie = (await refreshCookie(page))!;
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe('Strict');
    expect(cookie.path).toBe('/api/session');
  });

  test('another site cannot use the session endpoints (CSRF): no header or a foreign origin is refused', async ({ page, request }) => {
    await signedIn(page);
    const noHeader = await page.request.post('/api/session/refresh');
    expect(noHeader.status()).toBe(403);
    const foreign = await page.request.post('/api/session/refresh', { headers: { 'x-tirvona-csrf': '1', origin: 'https://evil.example.net' } });
    expect(foreign.status()).toBe(403);
    // A client with no cookie jar (the `request` fixture) has no session to ride on.
    const stranger = await request.post('/api/session/refresh', { headers: { 'x-tirvona-csrf': '1' } });
    expect(stranger.status()).toBe(401);
  });

  test('signing out in one tab ends the session everywhere: the refresh cookie no longer works', async ({ page }) => {
    await signedIn(page);
    const cookie = (await refreshCookie(page))!;
    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: 'Radha Ashram' })).toBeVisible();
    await page.getByTitle('Sign Out').click();
    await expect(page).toHaveURL(/\/login$/);
    // Replaying the old cookie value is refused by the API: the session was revoked, not just forgotten by the browser.
    await page.context().addCookies([{ name: cookie.name, value: cookie.value, domain: cookie.domain, path: cookie.path, httpOnly: true, sameSite: 'Strict', secure: cookie.secure }]);
    const replay = await page.request.post('/api/session/refresh', { headers: { 'x-tirvona-csrf': '1' } });
    expect(replay.status()).toBe(401);
  });
});
