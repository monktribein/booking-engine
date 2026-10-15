import { decryptSecret } from '../src/database/common/crypto';
import { bearer, login, registerOwner, Session } from './utils/fixtures';
import { createTestApp, TestApp } from './utils/test-app';

describe('Authentication', () => {
  let t: TestApp;
  let owner: Session;

  beforeAll(async () => {
    t = await createTestApp({ THROTTLE_AUTH_LIMIT: '8' });
    owner = await registerOwner(t, 'auth');
  });
  afterAll(() => t.close());

  it('registers an owner, returns tokens, never returns the password hash', async () => {
    const res = await t.http().post('/auth/register').send({ name: 'A', email: 'dup-check@example.com', password: 'Str0ng-passw0rd', organizationName: 'Org A' }).expect(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toMatchObject({ accessToken: expect.any(String), refreshToken: expect.any(String), expiresIn: 900 });
    expect(res.body.data.user.role).toBe('PROPERTY_OWNER');
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|scrypt\$/);
    const stored = await t.conn.db!.collection('users').findOne({ email: 'dup-check@example.com' });
    expect(stored!.passwordHash).toMatch(/^scrypt\$/); // hashed at rest
  });

  it('rejects duplicate emails and weak passwords', async () => {
    const dup = await t.http().post('/auth/register').send({ name: 'A', email: 'dup-check@example.com', password: 'Str0ng-passw0rd', organizationName: 'Org B' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('EMAIL_TAKEN');
    const weak = await t.http().post('/auth/register').send({ name: 'A', email: 'weak@example.com', password: 'short', organizationName: 'Org C' });
    expect(weak.status).toBe(400);
    expect(weak.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('logs in and rejects wrong passwords and unknown emails identically', async () => {
    const ok = await login(t, owner.email, owner.password);
    expect(ok.token).toBeTruthy();
    const bad = await t.http().post('/auth/login').send({ email: owner.email, password: 'Wrong-passw0rd' });
    const unknown = await t.http().post('/auth/login').send({ email: 'nobody@example.com', password: 'Wrong-passw0rd' });
    expect(bad.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(bad.body.error).toEqual(unknown.body.error);
  });

  it('requires a valid bearer token on protected routes', async () => {
    expect((await t.http().get('/auth/me')).status).toBe(401);
    expect((await t.http().get('/auth/me').set(bearer('not.a.jwt'))).body.error.code).toBe('TOKEN_INVALID');
    const me = await t.http().get('/auth/me').set(bearer(owner.token)).expect(200);
    expect(me.body.data.email).toBe(owner.email);
    expect(me.body.data.passwordHash).toBeUndefined();
  });

  it('rotates refresh tokens and revokes the whole session family on reuse', async () => {
    const s = await login(t, owner.email, owner.password);
    const r1 = await t.http().post('/auth/refresh').send({ refreshToken: s.refreshToken }).expect(200);
    const rotated = r1.body.data.refreshToken;
    expect(rotated).not.toBe(s.refreshToken);
    await t.http().get('/auth/me').set(bearer(r1.body.data.accessToken)).expect(200);

    // Replaying the old token = theft signal.
    const replay = await t.http().post('/auth/refresh').send({ refreshToken: s.refreshToken });
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('TOKEN_REUSED');
    // The legitimate newer tokens are revoked too.
    expect((await t.http().post('/auth/refresh').send({ refreshToken: rotated })).status).toBe(401);
    expect((await t.http().get('/auth/me').set(bearer(r1.body.data.accessToken))).body.error.code).toBe('SESSION_REVOKED');
  });

  it('logout invalidates the access token immediately', async () => {
    const s = await login(t, owner.email, owner.password);
    await t.http().post('/auth/logout').set(bearer(s.token)).expect(200);
    const after = await t.http().get('/auth/me').set(bearer(s.token));
    expect(after.status).toBe(401);
    expect(after.body.error.code).toBe('SESSION_REVOKED');
    expect((await t.http().post('/auth/refresh').send({ refreshToken: s.refreshToken })).status).toBe(401);
  });

  it('forgot/reset password: link is delivered encrypted, single use, and signs out every session', async () => {
    const before = await login(t, owner.email, owner.password);
    await t.http().post('/auth/forgot-password').send({ email: owner.email }).expect(200);
    // Unknown emails get the same answer (no account enumeration).
    await t.http().post('/auth/forgot-password').send({ email: 'ghost@example.com' }).expect(200);

    const n = await t.conn.db!.collection('notifications').findOne({ type: 'PASSWORD_RESET', recipient: owner.email });
    expect(n!.message).not.toMatch(/token=/); // the link is not stored in clear
    const link = decryptSecret(n!.metadata.encryptedLink);
    const token = new URL(link).searchParams.get('token')!;
    await t.drain(); // notification worker sends it and strips the link
    const sent = await t.conn.db!.collection('notifications').findOne({ _id: n!._id });
    expect(sent!.status).toBe('SENT');
    expect(sent!.metadata.encryptedLink).toBeUndefined();

    await t.http().post('/auth/reset-password').send({ token, newPassword: 'N3w-passw0rd!' }).expect(200);
    expect((await t.http().post('/auth/reset-password').send({ token, newPassword: 'An0ther-pass' })).status).toBe(401); // single use
    expect((await t.http().get('/auth/me').set(bearer(before.token))).status).toBe(401);
    await login(t, owner.email, 'N3w-passw0rd!');
    owner.password = 'N3w-passw0rd!';
  });

  it('rate-limits credential endpoints', async () => {
    const attempts = await Promise.all(Array.from({ length: 12 }, () => t.http().post('/auth/login').send({ email: 'rl@example.com', password: 'Wrong-passw0rd' })));
    const limited = attempts.filter((r) => r.status === 429);
    expect(limited.length).toBeGreaterThan(0);
    expect(limited[0].body.error.code).toBe('RATE_LIMITED');
  });

  it('responds with secure headers', async () => {
    const res = await t.http().get('/health').expect(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.body).toMatchObject({ success: true, data: { status: 'ok' } });
  });
});
