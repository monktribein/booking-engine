import { JsonLogger, redact, redactValue, useJsonLogs } from './json-logger';

describe('log redaction', () => {
  it.each([
    ['Authorization: Bearer abc.def.ghi-123', /\*\*\*/],
    ['sent Bearer abc.def.ghi-123 upstream', /Bearer \*\*\*/],
    ['token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk', /\*\*\*jwt\*\*\*/], // secret-scan:allow (fake fixture)
    ['connect mongodb+srv://admin:s3cret@cluster0.mongodb.net/db failed', /mongodb\+srv:\/\/\*\*\*@cluster0/], // secret-scan:allow (fake fixture)
    ['redis://:hunter2@redis.internal:6379', /redis:\/\/\*\*\*@redis/],
    ['smtp://user:pw@smtp.example.com:587', /smtp:\/\/\*\*\*@smtp/],
    ['password=hunter2 and next', /password="\*\*\*"/],
    ['{"refreshToken":"abc123","x":1}', /refreshToken":"\*\*\*"/],
    ['guest priya.sharma@example.com booked', /p\*\*\*@example\.com/],
    ['call +91 98765 43210 now', /\+91\*\*\*10/],
  ])('%s', (input, expected) => {
    const out = redact(input);
    expect(out).toMatch(expected);
    expect(out).not.toMatch(/s3cret|hunter2|abc123|abc\.def|priya\.sharma|98765/);
  });

  it('masks sensitive keys in structured payloads, recursively, and leaves the rest', () => {
    expect(redactValue({ event: 'x', email: 'a@b.co', nested: { password: 'p', ok: 1, list: [{ token: 't', n: 2 }] } })).toEqual({
      event: 'x',
      email: '***',
      nested: { password: '***', ok: 1, list: [{ token: '***', n: 2 }] },
    });
  });
});

describe('JsonLogger', () => {
  const lines: string[] = [];
  beforeEach(() => {
    lines.length = 0;
    jest.spyOn(process.stdout, 'write').mockImplementation(((c: string) => (lines.push(String(c)), true)) as never);
    jest.spyOn(process.stderr, 'write').mockImplementation(((c: string) => (lines.push(String(c)), true)) as never);
  });
  afterEach(() => jest.restoreAllMocks());

  it('writes one JSON object per line with level, ts, service and context', () => {
    new JsonLogger('svc').log('hello Bearer secret-token-value', 'Ctx');
    const o = JSON.parse(lines[0]);
    expect(o).toMatchObject({ level: 'info', service: 'svc', context: 'Ctx' });
    expect(o.message).toBe('hello Bearer ***');
    expect(typeof o.ts).toBe('string');
  });

  it('structured events keep their fields and are redacted; errors carry a redacted trace', () => {
    const l = new JsonLogger();
    l.warn({ event: 'payment_failed', reason: 'declined for a@b.co', paymentId: 'p1' }, 'Payments');
    expect(JSON.parse(lines[0])).toMatchObject({ level: 'warn', event: 'payment_failed', paymentId: 'p1', reason: 'declined for a***@b.co', context: 'Payments' });
    l.error('boom', 'Error: x\n at mongodb://u:p@h/db', 'HTTP');
    const e = JSON.parse(lines[1]);
    expect(e.level).toBe('error');
    expect(e.trace).not.toContain('u:p@');
  });

  it('uses JSON logs in production unless LOG_FORMAT=text', () => {
    expect(useJsonLogs({ NODE_ENV: 'production' } as never)).toBe(true);
    expect(useJsonLogs({ NODE_ENV: 'production', LOG_FORMAT: 'text' } as never)).toBe(false);
    expect(useJsonLogs({ NODE_ENV: 'development' } as never)).toBe(false);
    expect(useJsonLogs({ NODE_ENV: 'development', LOG_FORMAT: 'json' } as never)).toBe(true);
  });
});
