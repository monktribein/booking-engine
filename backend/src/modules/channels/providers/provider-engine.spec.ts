import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { extractAll, extractOne, readField, redactText, redactUrl, renderBody, renderString } from './provider-engine';
import { assertSafeRequest, HttpSafetyError, secureRequest } from './secure-http';

describe('restricted JSONPath', () => {
  const doc = { data: [{ id: 'a', tags: ['x', 'y'], 'display-name': 'A' }, { id: 'b' }], meta: { next: 'c2' } };
  it('selects keys, indexes and wildcards', () => {
    expect(extractAll(doc, '$.data[*].id')).toEqual(['a', 'b']);
    expect(extractOne(doc, '$.data[0].tags[1]')).toBe('y');
    expect(extractOne(doc, "$.data[0]['display-name']")).toBe('A');
    expect(extractOne(doc, '$.meta.next')).toBe('c2');
    expect(extractAll(doc, '$')).toEqual([doc]);
  });
  it('missing properties select nothing and never throw', () => {
    expect(extractAll(doc, '$.nope.deeper')).toEqual([]);
    expect(extractAll(doc, '$.data[9]')).toEqual([]);
    expect(extractOne('text', '$.a')).toBeUndefined();
  });
  it('cannot reach the prototype chain', () => {
    expect(() => extractAll(doc, '$.__proto__')).toThrow();
    expect(() => extractAll(doc, "$['constructor']")).toThrow();
    // inherited properties are never visible even without the name filter
    expect(extractAll({}, '$.toString')).toEqual([]);
    expect(extractAll([], '$.length')).toEqual([]);
  });
  it('reads fields with maps, defaults and transforms', () => {
    const item = { st: 'conf', price: 12345, d: '2027-01-02' };
    expect(readField(item, { path: '$.st', map: { conf: 'OK' } })).toBe('OK');
    expect(readField(item, { path: '$.zz', default: 7 })).toBe(7);
    expect(readField(item, { path: '$.price', transform: 'minorToMajor' })).toBe(123.45);
    expect(readField(item, { path: '$.d', transform: 'dateCompact' })).toBe('20270102');
    expect(readField(item, { path: '$.st', map: { other: 'x' } })).toBeUndefined();
  });
});

describe('templates', () => {
  it('substitutes only supplied values and encodes path segments', () => {
    expect(renderString('/p/{externalListingId}/rooms', { externalListingId: 'a b/c' }, 'path')).toBe('/p/a%20b%2Fc/rooms');
    expect(() => renderString('/p/{externalListingId}', { externalListingId: '..' }, 'path')).toThrow(/unsafe/);
    expect(() => renderString('/p/{externalListingId}', { externalListingId: '' }, 'path')).toThrow();
    expect(() => renderString('/p/{x}', {}, 'path')).toThrow(/not available/);
  });
  it('refuses values with control characters (header injection)', () => {
    expect(() => renderString('{since}', { since: 'a\r\nHost: evil' })).toThrow(/control/);
  });
  it('a lone placeholder keeps its type; $each expands the updates', () => {
    const out = renderBody({ rates: { $each: 'updates', item: { room: '{item.externalRoomId}', amount: '{item.price|minorToMajor}', stop: '{item.stopSell}', label: 'r-{item.date}' } }, n: 1 }, {}, [
      { externalRoomId: 'R1', price: 150000, stopSell: false, date: '2027-01-01' },
      { externalRoomId: 'R2', price: 99900, stopSell: true, date: '2027-01-02' },
    ]);
    expect(out).toEqual({
      rates: [
        { room: 'R1', amount: 1500, stop: false, label: 'r-2027-01-01' },
        { room: 'R2', amount: 999, stop: true, label: 'r-2027-01-02' },
      ],
      n: 1,
    });
  });
  it('does not evaluate anything in values', () => {
    expect(renderString('{since}', { since: '${process.env.SECRET}' })).toBe('${process.env.SECRET}');
  });
});

describe('redaction', () => {
  it('removes known secrets and credential shapes', () => {
    const s = redactText('Authorization: Bearer abc123def456ghi and x-api-key=SuperSecretValue and "password":"hunter2hunter2"', ['SuperSecretValue']);
    expect(s).not.toMatch(/abc123def456ghi|SuperSecretValue|hunter2/);
  });
  it('strips url credentials and secret query values', () => {
    const u = redactUrl('https://user:pw@api.example.com/x?api_key=SECRET1&q=hello&token=T');
    expect(u).not.toMatch(/SECRET1|pw|token=T/);
    expect(u).toContain('q=hello');
  });
});

describe('secure HTTP client', () => {
  const allowed = new Set(['api.example.com']);
  const base = { allowedHosts: allowed, timeoutMs: 1000, maxRequestBytes: 1000, maxResponseBytes: 1000, headers: {} as Record<string, string>, method: 'GET' as const };
  const reject = (url: string, extra: Record<string, unknown> = {}) => () => assertSafeRequest({ ...base, url: new URL(url), ...extra } as never);

  it('allows only https to a listed host on the default port', () => {
    expect(reject('https://api.example.com/x')).not.toThrow();
    expect(reject('http://api.example.com/x')).toThrow(HttpSafetyError);
    expect(reject('https://other.example.com/x')).toThrow(/allowed hosts/);
    expect(reject('https://api.example.com:8443/x')).toThrow(/port/);
    expect(reject('https://u:p@api.example.com/x')).toThrow(/credentials/);
    expect(reject('ftp://api.example.com/x')).toThrow();
    expect(reject('file:///etc/passwd')).toThrow();
  });
  it('refuses IP-literal hosts even when listed', () => {
    const r = () => assertSafeRequest({ ...base, allowedHosts: new Set(['169.254.169.254']), url: new URL('https://169.254.169.254/latest/meta-data') });
    expect(r).toThrow(/IP address/);
  });
  it('refuses forbidden methods, headers and oversized bodies', () => {
    expect(reject('https://api.example.com/x', { method: 'DELETE' })).toThrow(/method/);
    expect(reject('https://api.example.com/x', { headers: { Host: 'evil' } })).toThrow(/header/);
    expect(reject('https://api.example.com/x', { headers: { 'X-A': 'a\r\nb: c' } })).toThrow(/header/);
    expect(reject('https://api.example.com/x', { method: 'POST', body: 'x'.repeat(2000) })).toThrow(/too large/);
  });

  describe('against a local server (private targets explicitly enabled, as in tests)', () => {
    let server: http.Server;
    let url: string;
    let mode = 'ok';
    beforeAll(async () => {
      server = http.createServer((req, res) => {
        if (mode === 'redirect') {
          res.writeHead(302, { Location: 'http://169.254.169.254/' });
          return res.end();
        }
        if (mode === 'big') return res.end('x'.repeat(5000));
        if (mode === 'slow') {
          res.writeHead(200);
          const t = setInterval(() => res.write('.'), 50);
          res.on('close', () => clearInterval(t));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/x`;
    });
    afterAll(() => new Promise<void>((r) => server.close(() => r())));
    const req = (over: Record<string, unknown> = {}) => secureRequest({ ...base, allowedHosts: new Set(['127.0.0.1']), url: new URL(url), allowPrivate: true, ...over } as never);

    it('works, and is refused when private targets are not enabled', async () => {
      mode = 'ok';
      expect((await req()).status).toBe(200);
      await expect(req({ allowPrivate: false })).rejects.toBeInstanceOf(HttpSafetyError);
    });
    it('never follows redirects', async () => {
      mode = 'redirect';
      await expect(req()).rejects.toMatchObject({ code: 'REDIRECT_REFUSED' });
    });
    it('aborts an oversized response', async () => {
      mode = 'big';
      await expect(req()).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' });
    });
    it('enforces a total deadline even when the server keeps dripping data', async () => {
      mode = 'slow';
      const started = Date.now();
      await expect(req({ timeoutMs: 300 })).rejects.toMatchObject({ code: 'TIMEOUT' });
      expect(Date.now() - started).toBeLessThan(2000);
    });
  });

  it('a hostname that resolves to a private address is refused at connect time (DNS rebinding)', async () => {
    // "localhost" resolves to a loopback address; it is listed as allowed here to prove the connect-time check, not the host list, blocks it
    await expect(secureRequest({ ...base, allowedHosts: new Set(['localhost']), url: new URL('https://localhost/x') })).rejects.toMatchObject({ code: expect.stringMatching(/URL_REJECTED|NETWORK/) });
  });
});
