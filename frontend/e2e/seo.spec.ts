import { expect, test } from '@playwright/test';

test.describe('crawler files', () => {
  test('robots.txt keeps private areas out and points at the sitemap', async ({ request }) => {
    const res = await request.get('/robots.txt');
    expect(res.status()).toBe(200);
    const body = await res.text();
    for (const path of ['/dashboard', '/admin', '/booking', '/api', '/login']) expect(body).toContain(`Disallow: ${path}`);
    expect(body).toMatch(/Sitemap: .+\/sitemap\.xml/);
  });

  test('sitemap.xml lists the public search page and the real seeded property, nothing private', async ({ request }) => {
    const res = await request.get('/sitemap.xml');
    expect(res.status()).toBe(200);
    const body = await res.text();
    expect(body).toContain('/stays</loc>');
    expect(body).toContain('/stays/radha-ashram</loc>');
    expect(body).not.toMatch(/\/(dashboard|admin|booking|login)/);
  });

  test('the dashboard and admin shells are marked noindex', async ({ request }) => {
    for (const path of ['/dashboard', '/admin']) {
      const html = await (await request.get(path)).text();
      expect(html).toMatch(/<meta name="robots" content="noindex, nofollow"/);
    }
  });
});
