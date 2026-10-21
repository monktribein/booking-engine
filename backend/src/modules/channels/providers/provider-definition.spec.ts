import { exampleRestDefinition } from './example-definition';
import { type ProviderDefinition, validateDefinition } from './provider-definition';

const base = () => exampleRestDefinition({ baseUrl: 'https://api.acme-stay.example.com', host: 'api.acme-stay.example.com' });
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
const invalid = (mutate: (d: any) => void, opts = {}) => {
  const d: any = clone(base());
  mutate(d);
  return validateDefinition(d, opts);
};
const paths = (r: ReturnType<typeof validateDefinition>) => r.errors.map((e) => e.path);

describe('provider definition validation', () => {
  it('accepts the reference definition', () => {
    const r = validateDefinition(base());
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('rejects anything that is not a plain object, and unknown keys at every level', () => {
    expect(validateDefinition('x').ok).toBe(false);
    expect(validateDefinition([]).ok).toBe(false);
    expect(paths(invalid((d) => (d.script = 'process.exit()')))).toContain('script');
    expect(paths(invalid((d) => (d.operations.healthCheck.eval = '1')))).toContain('operations.healthCheck.eval');
    expect(paths(invalid((d) => (d.auth.extra = 1)))).toContain('auth.extra');
  });

  it('rejects prototype-pollution keys anywhere', () => {
    const d: any = JSON.parse('{"__proto__": {"polluted": true}}');
    const r = validateDefinition(d);
    expect(r.ok).toBe(false);
    const nested: any = clone(base());
    nested.operations.listListings.fields = JSON.parse('{"constructor": "$.x"}');
    expect(validateDefinition(nested).ok).toBe(false);
    expect(({} as any).polluted).toBeUndefined();
  });

  describe('hosts', () => {
    it('requires https and a base URL host that is listed', () => {
      expect(paths(invalid((d) => (d.environments.production.baseUrl = 'http://api.acme-stay.example.com')))).toContain('environments.production.baseUrl');
      expect(paths(invalid((d) => (d.environments.production.baseUrl = 'https://evil.example.com')))).toContain('environments.production.baseUrl');
      expect(paths(invalid((d) => (d.environments.production.baseUrl = 'https://user:pw@api.acme-stay.example.com')))).toContain('environments.production.baseUrl');
      expect(paths(invalid((d) => (d.environments.production.baseUrl = 'https://api.acme-stay.example.com:8443')))).toContain('environments.production.baseUrl');
      expect(paths(invalid((d) => (d.environments.production.baseUrl = 'https://api.acme-stay.example.com/v1?x=1')))).toContain('environments.production.baseUrl');
    });

    it.each(['localhost', '127.0.0.1', '10.0.0.5', '169.254.169.254', '[::1]', '*.example.com', 'internal.local', 'metadata.internal', 'api.example.com:443', 'http://x.com', 'a'])('rejects the allowed host %s', (host) => {
      expect(invalid((d) => (d.allowedHosts = [host])).ok).toBe(false);
    });

    it('allows a local fake server only when explicitly enabled (tests/dev)', () => {
      const local = (d: any) => {
        d.allowedHosts = ['127.0.0.1'];
        d.environments = { production: { baseUrl: 'http://127.0.0.1:4010' } };
      };
      expect(invalid(local).ok).toBe(false);
      expect(invalid(local, { allowInsecureHosts: true }).errors).toEqual([]);
    });
  });

  describe('operations', () => {
    it('requires a GET health check so a connection can be verified without changing anything', () => {
      expect(paths(invalid((d) => delete d.operations.healthCheck))).toContain('operations.healthCheck');
      expect(paths(invalid((d) => (d.operations.healthCheck.method = 'POST')))).toContain('operations.healthCheck.method');
    });

    it('refuses DELETE and unknown methods and operations', () => {
      expect(paths(invalid((d) => (d.operations.pushRates.method = 'DELETE')))).toContain('operations.pushRates.method');
      expect(paths(invalid((d) => (d.operations.listListings.method = 'TRACE')))).toContain('operations.listListings.method');
      expect(paths(invalid((d) => (d.operations.dropEverything = { method: 'GET', path: '/x' })))).toContain('operations.dropEverything');
    });

    it.each(['v1/properties', '//evil.com/x', '/a/../b', '/a?x=1', '/a#f', 'https://evil.com/x', '/a\\b'])('refuses the path %s', (p) => {
      expect(invalid((d) => (d.operations.healthCheck.path = p)).ok).toBe(false);
    });

    it('allows only whitelisted placeholders, and only identifiers inside paths', () => {
      expect(paths(invalid((d) => (d.operations.listListings.query = { q: '{process.env.SECRET}' })))).toContain('operations.listListings.query.q');
      expect(paths(invalid((d) => (d.operations.listRoomTypes.path = '/v1/{cursor}/rooms')))).toContain('operations.listRoomTypes.path');
      expect(paths(invalid((d) => (d.operations.listListings.query = { q: '{externalListingId}' })))).toContain('operations.listListings.query.q'); // not available in listListings
      expect(paths(invalid((d) => (d.operations.listListings.query = { q: '{since' })))).toContain('operations.listListings.query.q');
      expect(paths(invalid((d) => (d.operations.listListings.query = { q: '{cursor|rm_rf}' })))).toContain('operations.listListings.query.q');
    });

    it('rejects header injection and engine-controlled headers', () => {
      expect(invalid((d) => (d.operations.healthCheck.headers = { 'X-A': 'v\r\nHost: evil' })).ok).toBe(false);
      for (const h of ['Host', 'Authorization', 'Content-Length', 'Cookie', 'Transfer-Encoding', 'X-Forwarded-For', 'Content-Type']) {
        expect(invalid((d) => (d.operations.healthCheck.headers = { [h]: 'x' })).ok).toBe(false);
      }
      expect(invalid((d) => (d.operations.healthCheck.headers = { 'X-Tenant': 'abc' })).errors).toEqual([]);
      expect(invalid((d) => (d.auth = { type: 'API_KEY_HEADER', header: 'Host' })).ok).toBe(false);
    });

    it('limits body templates: no foreign directives, no deep nesting, $each only over updates', () => {
      expect(invalid((d) => (d.operations.pushRates.body = { x: { $eval: 'x' } })).ok).toBe(false);
      expect(invalid((d) => (d.operations.pushRates.body = { x: { $each: 'secrets', item: {} } })).ok).toBe(false);
      expect(invalid((d) => (d.operations.pushRates.body = { x: '{item.nope}' })).ok).toBe(false);
      let deep: any = 'x';
      for (let i = 0; i < 12; i++) deep = { a: deep };
      expect(invalid((d) => (d.operations.pushRates.body = deep)).ok).toBe(false);
    });

    it('a push operation needs a body, a GET has none', () => {
      expect(paths(invalid((d) => delete d.operations.pushRates.body))).toContain('operations.pushRates.body');
      expect(paths(invalid((d) => (d.operations.listListings.body = { a: 1 })))).toContain('operations.listListings.body');
    });

    it('restricts JSONPath to the safe subset', () => {
      for (const p of ['$..id', '$.a[?(@.x==1)]', '$.a.__proto__', "$['constructor']", '$.a[(1+1)]', 'a.b', '$.a b', '$.a[-1]']) {
        expect(invalid((d) => (d.operations.listListings.fields.name = p)).ok).toBe(false);
      }
      expect(invalid((d) => (d.operations.listListings.fields.name = "$.data[0]['display-name']")).errors).toEqual([]);
    });
  });

  describe('capabilities', () => {
    it('a declared capability needs its operation, an undeclared one is flagged as unreachable', () => {
      expect(paths(invalid((d) => delete d.operations.pushRates))).toContain('capabilities.pushRates');
      const r = invalid((d) => (d.capabilities.pushRates = false));
      expect(r.ok).toBe(true);
      expect(r.warnings.map((w) => w.path)).toContain('operations.pushRates');
    });

    it('rejects unknown capability names and non-boolean values', () => {
      expect(paths(invalid((d) => (d.capabilities.teleport = true)))).toContain('capabilities.teleport');
      expect(paths(invalid((d) => (d.capabilities.listings = 'yes')))).toContain('capabilities.listings');
    });
  });

  describe('auth, signing, webhooks', () => {
    it('only supports the declarative auth types (OAuth flows need a dedicated adapter)', () => {
      expect(paths(invalid((d) => (d.auth = { type: 'OAUTH2_AUTH_CODE' })))).toContain('auth.type');
      for (const auth of [{ type: 'NONE' }, { type: 'BEARER' }, { type: 'BASIC' }, { type: 'API_KEY_HEADER', header: 'X-Key' }]) {
        expect(invalid((d) => (d.auth = auth)).errors).toEqual([]);
      }
      const q = invalid((d) => (d.auth = { type: 'API_KEY_QUERY', param: 'key' }));
      expect(q.ok).toBe(true);
      expect(q.warnings.length).toBeGreaterThan(0);
    });

    it('webhook signatures are mandatory and must be HMAC-SHA256', () => {
      expect(paths(invalid((d) => delete d.webhook.signature))).toContain('webhook.signature');
      expect(paths(invalid((d) => (d.webhook.signature.scheme = 'NONE')))).toContain('webhook.signature.scheme');
      expect(paths(invalid((d) => delete d.webhook))).toContain('webhook');
    });

    it('who collects the payment is optional (omitted = unknown), validated when given, and the legacy boolean still loads', () => {
      expect(paths(invalid((d) => delete d.reservationMapping.paymentCollection))).toEqual([]);
      expect(paths(invalid((d) => (d.reservationMapping.paymentCollection = 'OTA')))).toContain('reservationMapping.paymentCollection');
      expect(paths(invalid((d) => { delete d.reservationMapping.paymentCollection; d.reservationMapping.paymentCollectedByChannel = true; }))).toEqual([]);
      expect(paths(invalid((d) => (d.reservationMapping.paymentCollectedByChannel = false)))).toContain('reservationMapping.paymentCollectedByChannel'); // both given
      expect(paths(invalid((d) => { delete d.reservationMapping.paymentCollection; d.reservationMapping.paymentCollectedByChannel = 'yes'; }))).toContain('reservationMapping.paymentCollectedByChannel');
    });

    it('provider payment fields are optional paths with mapped statuses, and a money path needs a unit', () => {
      const ok = { statusPath: '$.payment.status', statusMap: { paid: 'PAID' }, payoutStatusPath: '$.payout.state', payoutStatusMap: { sent: 'COMPLETED' }, payoutDatePath: '$.payout.date', commissionPath: '$.fee', netAmountPath: '$.net', amountUnit: 'MAJOR' };
      expect(paths(invalid((d) => (d.reservationMapping.paymentFields = ok)))).toEqual([]);
      expect(paths(invalid((d) => (d.reservationMapping.paymentFields = { ...ok, statusMap: { paid: 'SETTLED' } })))).toContain('reservationMapping.paymentFields.statusMap');
      expect(paths(invalid((d) => (d.reservationMapping.paymentFields = { ...ok, payoutStatusMap: { x: 'PAID' } })))).toContain('reservationMapping.paymentFields.payoutStatusMap');
      expect(paths(invalid((d) => (d.reservationMapping.paymentFields = { ...ok, amountUnit: undefined })))).toContain('reservationMapping.paymentFields.amountUnit');
      expect(paths(invalid((d) => (d.reservationMapping.paymentFields = { statusMap: { paid: 'PAID' } })))).toContain('reservationMapping.paymentFields.statusMap');
      expect(paths(invalid((d) => (d.reservationMapping.paymentFields = { ...ok, statusPath: 'not a path' })))).toContain('reservationMapping.paymentFields.statusPath');
      expect(paths(invalid((d) => (d.reservationMapping.paymentFields = { ...ok, secret: 1 })))).toContain('reservationMapping.paymentFields.secret');
    });

    it('reservation mapping must say how prices are given', () => {
      expect(paths(invalid((d) => (d.reservationMapping.pricing.unit = 'EUROS')))).toContain('reservationMapping.pricing.unit');
      expect(paths(invalid((d) => (d.reservationMapping.statusMap = { x: 'DELETE_EVERYTHING' })))).toContain('reservationMapping.statusMap');
    });
  });

  describe('platform ceilings', () => {
    it('a definition can lower but never raise the platform limits', () => {
      expect(paths(invalid((d) => (d.limits.timeoutMs = 600_000)))).toContain('limits.timeoutMs');
      expect(paths(invalid((d) => (d.limits.maxResponseBytes = 10_000_000_000)))).toContain('limits.maxResponseBytes');
      expect(paths(invalid((d) => (d.retry.maxAttempts = 1000)))).toContain('retry.maxAttempts');
      expect(paths(invalid((d) => (d.rateLimit.requestsPerSecond = 100_000)))).toContain('rateLimit.requestsPerSecond');
      expect(paths(invalid((d) => (d.operations.pushRates.batchSize = 1_000_000)))).toContain('operations.pushRates.batchSize');
      expect(paths(invalid((d) => (d.operations.listListings.pagination.maxPages = 100_000)))).toContain('operations.listListings.pagination.maxPages');
    });

    it('rejects an oversized definition', () => {
      const r = invalid((d) => (d.operations.listListings.fields = Object.fromEntries(Array.from({ length: 3000 }, (_, i) => [`f${i}`, '$.' + 'a'.repeat(30)]))));
      expect(r.ok).toBe(false);
      expect(r.errors.some((e) => /exceeds/.test(e.message))).toBe(true);
    });
  });

  it('returns the typed definition on success', () => {
    const r = validateDefinition(base());
    const d = r.definition as ProviderDefinition;
    expect(d.operations.healthCheck?.method).toBe('GET');
  });
});
