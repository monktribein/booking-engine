import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { UnsafeWebhookTargetError, isBlockedAddress, postWebhook, validateWebhookUrl } from './safe-http';
import { computeSignature, signatureHeader, verifySignature } from './webhook-signature';

describe('webhook target safety (SSRF)', () => {
  it.each([
    '127.0.0.1',
    '127.9.9.9',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254', // cloud metadata
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '::1',
    '::',
    'fe80::1',
    'fc00::1',
    'fd12:3456::1',
    '::ffff:127.0.0.1', // IPv4-mapped IPv6 must not bypass the check
    '::ffff:10.0.0.1',
    'not-an-ip',
  ])('blocks %s', (addr) => {
    expect(isBlockedAddress(addr)).toBe(true);
  });

  it.each(['8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '203.0.113.9', '2606:4700:4700::1111'])('allows public address %s', (addr) => {
    expect(isBlockedAddress(addr)).toBe(false);
  });

  it('production rules: https only, no credentials, no local hosts or literal private IPs', () => {
    expect(() => validateWebhookUrl('https://api.example.com/hook', false)).not.toThrow();
    for (const bad of ['http://api.example.com/hook', 'ftp://x.com', 'not a url', 'https://u:p@example.com', 'https://localhost/x', 'https://app.localhost/x', 'https://db.internal/x', 'https://10.0.0.5/x', 'https://[::1]/x', 'https://169.254.169.254/latest/meta-data']) {
      expect(() => validateWebhookUrl(bad, false)).toThrow(UnsafeWebhookTargetError);
    }
  });

  it('development allows http and loopback', () => {
    expect(() => validateWebhookUrl('http://127.0.0.1:4000/hook', true)).not.toThrow();
    expect(() => validateWebhookUrl('http://localhost:4000/hook', true)).not.toThrow();
  });

  describe('postWebhook', () => {
    let server: http.Server;
    let url: URL;
    let hits = 0;
    beforeAll(async () => {
      server = http.createServer((req, res) => {
        hits++;
        if (req.url === '/redirect') {
          res.writeHead(302, { Location: 'http://169.254.169.254/' });
          return res.end();
        }
        if (req.url === '/slow') return; // never answers
        res.end('ok');
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      url = new URL(`http://localhost:${(server.address() as AddressInfo).port}/`);
    });
    afterAll(() => new Promise<void>((r) => server.close(() => r())));

    it('refuses to connect when the hostname resolves to a loopback/private address (checked at connect time)', async () => {
      hits = 0;
      await expect(postWebhook(url, {}, '{}', { timeoutMs: 2000, allowPrivate: false })).rejects.toThrow(/private address/);
      expect(hits).toBe(0); // the request never reached the server
    });

    it('delivers when private targets are allowed (development)', async () => {
      expect((await postWebhook(url, { 'Content-Type': 'application/json' }, '{}', { timeoutMs: 2000, allowPrivate: true })).status).toBe(200);
    });

    it('does not follow redirects: a 3xx is reported as the status', async () => {
      const res = await postWebhook(new URL('/redirect', url), {}, '{}', { timeoutMs: 2000, allowPrivate: true });
      expect(res.status).toBe(302);
    });

    it('times out a receiver that never answers', async () => {
      await expect(postWebhook(new URL('/slow', url), {}, '{}', { timeoutMs: 300, allowPrivate: true })).rejects.toThrow(/timed out/);
    });
  });
});

describe('webhook signature', () => {
  const secret = 'whsec_test_secret';
  const body = '{"id":"evt_1","type":"reservation.confirmed"}';
  const now = 1_800_000_000_000;
  const t = now / 1000;

  it('round-trips and is deterministic', () => {
    expect(computeSignature(secret, t, body)).toBe(computeSignature(secret, t, body));
    expect(verifySignature(secret, signatureHeader(secret, t, body), body, { nowMs: now })).toBe(true);
  });

  it('binds the timestamp, the body and the secret', () => {
    const header = signatureHeader(secret, t, body);
    expect(verifySignature(secret, header, body + ' ', { nowMs: now })).toBe(false);
    expect(verifySignature('other', header, body, { nowMs: now })).toBe(false);
    expect(verifySignature(secret, header.replace(`t=${t}`, `t=${t + 1}`), body, { nowMs: now })).toBe(false); // changing t invalidates v1
  });

  it('enforces the replay window in both directions', () => {
    const header = signatureHeader(secret, t, body);
    expect(verifySignature(secret, header, body, { nowMs: now + 299_000 })).toBe(true);
    expect(verifySignature(secret, header, body, { nowMs: now + 301_000 })).toBe(false);
    expect(verifySignature(secret, header, body, { nowMs: now - 301_000 })).toBe(false);
  });

  it('rejects malformed headers', () => {
    for (const h of ['', 'v1=abc', `t=${t}`, `t=abc,v1=00`, `t=${t},v1=`, `t=${t},v1=zz`]) expect(verifySignature(secret, h, body, { nowMs: now })).toBe(false);
  });
});
