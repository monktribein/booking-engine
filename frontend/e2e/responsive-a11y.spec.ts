import fs from 'node:fs';
import path from 'node:path';
import { expect, Page, test } from '@playwright/test';
import { SLUG, signedIn } from './helpers';

/**
 * Layout and accessibility checks in a real browser at phone, tablet and desktop widths.
 *
 *  - no horizontal page scroll (content that is wider than the screen)
 *  - no uncaught script errors and no failed console errors
 *  - axe-core WCAG 2.0/2.1 A and AA rules: nothing serious or critical
 *
 * An automated scan finds roughly a third of accessibility problems; it does not prove the app is accessible. Keyboard and
 * dialog behaviour are checked separately below, and screen-reader use was not tested.
 *
 * A11Y_REPORT=1 writes every violation (any impact) to test-results/a11y-report.json instead of failing, to triage a new page.
 */
const axeSource = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

const VIEWPORTS = [
  { name: 'phone', width: 375, height: 812 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

type Who = 'guest' | 'owner' | 'admin';
const PAGES: { path: string; who: Who }[] = [
  { path: '/', who: 'guest' },
  { path: '/stays', who: 'guest' },
  { path: `/stays/${SLUG}`, who: 'guest' },
  { path: '/booking/lookup', who: 'guest' },
  { path: '/login', who: 'guest' },
  { path: '/register', who: 'guest' },
  { path: '/forgot-password', who: 'guest' },
  { path: '/dashboard', who: 'owner' },
  { path: '/dashboard/calendar', who: 'owner' },
  { path: '/dashboard/reservations', who: 'owner' },
  { path: '/dashboard/rooms', who: 'owner' },
  { path: '/dashboard/inventory', who: 'owner' },
  { path: '/dashboard/rates', who: 'owner' },
  { path: '/dashboard/channels', who: 'owner' },
  { path: '/dashboard/guests', who: 'owner' },
  { path: '/dashboard/payments', who: 'owner' },
  { path: '/dashboard/reports', who: 'owner' },
  { path: '/dashboard/settings', who: 'owner' },
  { path: '/dashboard/profile', who: 'owner' },
  { path: '/admin', who: 'admin' },
  { path: '/admin/partners', who: 'admin' },
];

const ADMIN = { email: process.env.E2E_ADMIN_EMAIL ?? 'admin@tirvona.demo', password: process.env.E2E_ADMIN_PASSWORD ?? 'SandboxAdmin-123' };
const report: Record<string, unknown[]> = {};

async function settle(page: Page) {
  await page.waitForLoadState('networkidle').catch(() => undefined);
  // Skeleton placeholders pulse until data arrives; wait for them to go (bounded) so we audit the real page, not the loading state.
  await page.waitForFunction(() => !document.querySelector('.animate-pulse'), undefined, { timeout: 8_000 }).catch(() => undefined);
}

async function overflowOf(page: Page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const vw = doc.clientWidth;
    const wide = [...document.querySelectorAll<HTMLElement>('body *')]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0 || r.right <= vw + 1) return false;
        // Scrollable regions (tables, tab bars) may be wider than the screen on purpose: only their own box matters.
        for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
          const o = getComputedStyle(p).overflowX;
          if (o === 'auto' || o === 'scroll' || o === 'hidden' || o === 'clip') return false;
        }
        return getComputedStyle(el).position !== 'fixed';
      })
      .slice(0, 5)
      .map((el) => `${el.tagName.toLowerCase()}.${String(el.className).split(' ').slice(0, 3).join('.')} right=${Math.round(el.getBoundingClientRect().right)}`);
    return { scrollWidth: doc.scrollWidth, clientWidth: vw, wide };
  });
}

for (const vp of VIEWPORTS) {
  test.describe(`${vp.name} ${vp.width}px`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    for (const pg of PAGES) {
      test(`${pg.path} (${pg.who}): no sideways scroll, no script errors, no serious accessibility violations`, async ({ page }) => {
        const errors: string[] = [];
        page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
        page.on('console', (m) => {
          // Expected: the sandbox answers 403 to non-admin screens and the fake Checkout host is not reachable.
          if (m.type() === 'error' && !/Failed to load resource|favicon|net::ERR|403|401/.test(m.text())) errors.push(`console: ${m.text()}`);
        });
        if (pg.who === 'owner') await signedIn(page);
        if (pg.who === 'admin') await signedIn(page, ADMIN.email, ADMIN.password);

        await page.goto(pg.path);
        await settle(page);
        await expect(page.locator('main, h1').first()).toBeVisible();

        const overflow = await overflowOf(page);
        expect.soft(overflow.scrollWidth, `page is wider than the screen: ${JSON.stringify(overflow.wide)}`).toBeLessThanOrEqual(overflow.clientWidth + 1);

        await page.evaluate(axeSource);
        const result = await page.evaluate(async () => {
          // @ts-expect-error axe is injected above
          const r = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } });
          return r.violations.map((v: { id: string; impact: string; help: string; nodes: { target: unknown[]; html: string }[] }) => ({
            id: v.id,
            impact: v.impact,
            help: v.help,
            count: v.nodes.length,
            sample: v.nodes.slice(0, 3).map((n) => ({ target: n.target.join(' '), html: n.html.slice(0, 140) })),
          }));
        });

        if (process.env.A11Y_REPORT) {
          report[`${vp.name} ${pg.path}`] = [...result, ...(overflow.scrollWidth > overflow.clientWidth + 1 ? [{ id: 'horizontal-overflow', ...overflow }] : []), ...errors.map((e) => ({ id: 'console', e }))];
          fs.mkdirSync('test-results', { recursive: true });
          fs.writeFileSync(path.join('test-results', 'a11y-report.json'), JSON.stringify(report, null, 1));
          return;
        }
        const blocking = result.filter((v: { impact: string }) => v.impact === 'serious' || v.impact === 'critical');
        expect.soft(blocking, `axe: ${JSON.stringify(blocking, null, 1)}`).toEqual([]);
        expect.soft(errors, 'browser console / script errors').toEqual([]);
      });
    }
  });
}

test.describe('keyboard', () => {
  test('the sign-in form is reachable and operable by keyboard alone, with a visible focus ring and an announced error', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Email Address').waitFor();
    const stops: string[] = [];
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Tab');
      const info = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el || el === document.body) return null; // focus left the page (browser chrome)
        const s = getComputedStyle(el);
        const ring = s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0 ? 'outline' : s.boxShadow !== 'none' ? 'shadow' : 'none';
        return { label: el.getAttribute('aria-label') || (el as HTMLInputElement).name || el.textContent?.trim().slice(0, 30) || el.tagName, ring };
      });
      if (!info) break;
      expect(info.ring, `visible focus indicator on "${info.label}"`).not.toBe('none');
      stops.push(info.label);
    }
    // email, password, (show-password / forgot-password links), sign in...: the whole form is reachable.
    expect(stops.length).toBeGreaterThanOrEqual(3);
    await page.getByLabel('Email Address').fill('nobody@example.com');
    await page.getByLabel('Password', { exact: true }).fill('wrong-password-1');
    await page.keyboard.press('Enter');
    await expect(page.locator('[role=alert]:not(#__next-route-announcer__)')).toContainText(/invalid|incorrect|credentials|password/i);
  });

  test('a dialog takes focus, keeps Tab inside, closes with Escape and returns focus to its trigger', async ({ page }) => {
    await signedIn(page);
    await page.goto('/dashboard/rooms');
    const trigger = page.getByRole('button', { name: /new room type/i });
    await trigger.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('aria-modal', 'true');
    // Focus is inside the dialog, and Tab never leaves it.
    for (let i = 0; i < 25; i++) {
      expect(await page.evaluate(() => !!document.activeElement?.closest('[role=dialog]')), `Tab ${i} stays inside the dialog`).toBe(true);
      await page.keyboard.press('Tab');
    }
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test('form errors are tied to their fields and announced', async ({ page }) => {
    await signedIn(page);
    await page.goto('/dashboard/rates');
    await page.getByRole('button', { name: 'New Promotion' }).click();
    const code = page.getByLabel('Promo Code *');
    await expect(code).toHaveAttribute('required', '');
    const total = page.getByLabel('Total uses');
    await total.fill('0');
    await page.getByLabel('Promo Code *').fill('A11Y1');
    await page.getByRole('button', { name: 'Create Promotion' }).click();
    // The browser blocks the submit and reports the invalid field (min=1) to assistive technology.
    expect(await total.evaluate((el: HTMLInputElement) => el.validity.rangeUnderflow)).toBe(true);
    expect(await total.evaluate((el: HTMLInputElement) => document.activeElement === el)).toBe(true);
  });
});
