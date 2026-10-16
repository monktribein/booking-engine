import http from 'node:http';
import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { expect, test } from '@playwright/test';
import { API, SLUG, appAlert, day, signedIn } from './helpers';

/**
 * Developer settings in a real browser against the real API: create an API key in the UI, use it against /v1 with a
 * plain HTTP client, revoke it in the UI and see it stop working; register a webhook endpoint, send a test event and
 * verify the signature the server produced.
 */
test.describe('developer settings (API keys and webhooks)', () => {
  test('an owner creates an API key, uses it on /v1, then revokes it', async ({ page, request }) => {
    await signedIn(page);
    await page.goto('/dashboard/settings');
    await page.getByRole('tab', { name: 'Developers' }).click();

    await page.getByLabel(/Key name/).fill('E2E partner');
    // keys are read-only by default; booking is a sensitive scope the owner must tick on purpose
    await page.getByLabel(/Create, change and cancel reservations/).check();
    await page.getByRole('button', { name: 'Create API key' }).click();
    const alert = appAlert(page).filter({ hasText: /shown only once/i });
    await expect(alert).toBeVisible();
    const key = /tvk_[a-z0-9]{8}_[A-Za-z0-9_-]{43}/.exec(await alert.innerText())?.[0];
    expect(key).toBeTruthy();
    const auth = { Authorization: `Bearer ${key}` };

    // the new key works against the public API...
    const props = await request.get(`${API}/v1/properties`, { headers: auth });
    expect(props.status()).toBe(200);
    expect(((await props.json()).data as { slug: string }[]).map((p) => p.slug)).toContain(SLUG);

    // ...books with an idempotency key, and a retry returns the same booking
    const avail = (await (await request.get(`${API}/v1/properties/${SLUG}/availability`, { headers: auth, params: { checkIn: day(25), checkOut: day(26), adults: 1 } })).json()).data;
    const body = {
      propertySlug: SLUG,
      checkIn: day(25),
      checkOut: day(26),
      adults: 1,
      rooms: [{ roomTypeId: avail[0].roomTypeId, ratePlanId: avail[0].ratePlans[0].ratePlanId, quantity: 1 }],
      guest: { firstName: 'Api', lastName: 'Tester', email: 'api.tester@example.com', phone: '+919811111111' },
    };
    const idem = { ...auth, 'Idempotency-Key': `e2e-${Date.now()}-abcdef` };
    const first = await request.post(`${API}/v1/reservations`, { headers: idem, data: body });
    expect(first.status()).toBe(201);
    const again = await request.post(`${API}/v1/reservations`, { headers: idem, data: body });
    expect(again.status()).toBe(200);
    expect((await again.json()).data.reservation.reservationCode).toBe((await first.json()).data.reservation.reservationCode);

    // the dashboard lists the key by prefix only; revoking it (after confirming) ends access at once
    await page.getByRole('button', { name: 'Dismiss' }).first().click();
    await expect(page.getByText('E2E partner')).toBeVisible();
    expect(await page.locator('body').innerText()).not.toContain(key!.slice(13));
    page.once('dialog', (d) => void d.accept());
    await page.getByRole('button', { name: 'Revoke E2E partner' }).click();
    await expect(appAlert(page).filter({ hasText: /stopped working immediately/ })).toBeVisible();
    const after = await request.get(`${API}/v1/properties`, { headers: auth });
    expect(after.status()).toBe(401);
    expect((await after.json()).error.code).toBe('API_KEY_REVOKED');
  });

  test('an owner registers a webhook endpoint, sends a test event and the signature verifies', async ({ page }) => {
    const received: { headers: http.IncomingHttpHeaders; body: string }[] = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received.push({ headers: req.headers, body });
        res.end('ok');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/tirvona`;
    try {
      await signedIn(page);
      await page.goto('/dashboard/settings');
      await page.getByRole('tab', { name: 'Developers' }).click();
      await page.getByLabel('Endpoint URL *').fill(url);
      await page.getByRole('button', { name: 'Add endpoint' }).click();
      const secretAlert = appAlert(page).filter({ hasText: /signing secret/i });
      await expect(secretAlert).toBeVisible();
      const secret = /whsec_[A-Za-z0-9_-]+/.exec(await secretAlert.innerText())?.[0];
      expect(secret).toBeTruthy();

      await page.getByRole('button', { name: 'Send test' }).last().click();
      await expect(appAlert(page).filter({ hasText: /Test event queued/ })).toBeVisible();
      await expect.poll(() => received.length, { timeout: 15_000 }).toBeGreaterThan(0);

      const [{ headers, body }] = received;
      expect(headers['tirvona-event-type']).toBe('ping');
      const m = /t=(\d+),v1=([0-9a-f]{64})/.exec(String(headers['tirvona-signature']))!;
      expect(createHmac('sha256', secret!).update(`${m[1]}.${body}`).digest('hex')).toBe(m[2]);

      await page.getByRole('button', { name: 'Deliveries' }).last().click();
      await expect(page.getByRole('dialog').or(page.locator('[role=dialog]')).getByText('ping')).toBeVisible();
      await expect(page.getByText('delivered', { exact: true })).toBeVisible();

      // clean up: an endpoint left behind would keep retrying against a receiver that no longer exists
      await page.keyboard.press('Escape');
      page.once('dialog', (d) => void d.accept());
      await page.getByRole('button', { name: `Delete ${url}` }).click();
      await expect(page.getByText(url)).toHaveCount(0);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
