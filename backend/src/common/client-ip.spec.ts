import { clientIp } from './client-ip';

const SECRET = 'a'.repeat(40);
const req = (headers: Record<string, string>, ip = '10.0.0.9') => ({ ip, get: (h: string) => headers[h.toLowerCase()] }) as never;

describe('clientIp (the web app forwards the visitor address, proving itself with a shared secret)', () => {
  const original = process.env.BFF_SHARED_SECRET;
  afterEach(() => {
    if (original === undefined) delete process.env.BFF_SHARED_SECRET;
    else process.env.BFF_SHARED_SECRET = original;
  });

  it('uses the forwarded address only when the secret matches', () => {
    process.env.BFF_SHARED_SECRET = SECRET;
    expect(clientIp(req({ 'x-tirvona-bff-secret': SECRET, 'x-tirvona-client-ip': '203.0.113.7' }))).toBe('203.0.113.7');
    expect(clientIp(req({ 'x-tirvona-bff-secret': SECRET, 'x-tirvona-client-ip': '2001:db8::1' }))).toBe('2001:db8::1');
  });

  it('ignores the header with a wrong, missing or empty secret, so nobody else can pick the address', () => {
    process.env.BFF_SHARED_SECRET = SECRET;
    expect(clientIp(req({ 'x-tirvona-bff-secret': 'b'.repeat(40), 'x-tirvona-client-ip': '203.0.113.7' }))).toBe('10.0.0.9');
    expect(clientIp(req({ 'x-tirvona-client-ip': '203.0.113.7' }))).toBe('10.0.0.9');
    expect(clientIp(req({ 'x-tirvona-bff-secret': '', 'x-tirvona-client-ip': '203.0.113.7' }))).toBe('10.0.0.9');
  });

  it('is off entirely when no secret is configured', () => {
    delete process.env.BFF_SHARED_SECRET;
    expect(clientIp(req({ 'x-tirvona-bff-secret': SECRET, 'x-tirvona-client-ip': '203.0.113.7' }))).toBe('10.0.0.9');
  });

  it('rejects a forwarded value that is not an IP address', () => {
    process.env.BFF_SHARED_SECRET = SECRET;
    expect(clientIp(req({ 'x-tirvona-bff-secret': SECRET, 'x-tirvona-client-ip': 'evil, 1.2.3.4' }))).toBe('10.0.0.9');
    expect(clientIp(req({ 'x-tirvona-bff-secret': SECRET, 'x-tirvona-client-ip': '' }))).toBe('10.0.0.9');
  });
});
