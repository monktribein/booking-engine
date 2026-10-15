import { bearer, login, registerOwner, Session } from './utils/fixtures';
import { createTestApp, TestApp } from './utils/test-app';

describe('Change own password (POST /auth/change-password)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t.close();
  });

  const change = (s: Session, body: Record<string, unknown>) => t.http().post('/auth/change-password').set(bearer(s.token)).send(body);

  it('needs the current password; a wrong one is a 400 (not a 401) and changes nothing', async () => {
    const s = await registerOwner(t, 'cp1');
    const bad = await change(s, { currentPassword: 'not-the-password-1', newPassword: 'Another-passw0rd' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details.fields.currentPassword).toBeDefined();
    await login(t, s.email, s.password); // old password still works
    expect((await t.http().post('/auth/change-password').send({ currentPassword: s.password, newPassword: 'Another-passw0rd' })).status).toBe(401);
  });

  it('validates the new password and refuses reuse', async () => {
    const s = await registerOwner(t, 'cp2');
    expect((await change(s, { currentPassword: s.password, newPassword: 'short1' })).status).toBe(400);
    expect((await change(s, { currentPassword: s.password, newPassword: 'onlyletterspassword' })).status).toBe(400);
    expect((await change(s, { currentPassword: s.password, newPassword: s.password })).status).toBe(400);
    expect((await change(s, { currentPassword: s.password })).status).toBe(400);
  });

  it('switches the password, keeps this login, and ends every other login', async () => {
    const s = await registerOwner(t, 'cp3');
    const other = await login(t, s.email, s.password); // a second device
    const res = await change(s, { currentPassword: s.password, newPassword: 'Brand-new-passw0rd' });
    expect(res.status).toBe(200);

    expect((await t.http().get('/auth/me').set(bearer(s.token))).status).toBe(200); // the session that changed it survives
    const dead = await t.http().get('/auth/me').set(bearer(other.token));
    expect(dead.status).toBe(401);
    expect(dead.body.error.code).toBe('SESSION_REVOKED');
    expect((await t.http().post('/auth/refresh').send({ refreshToken: other.refreshToken })).status).toBe(401);

    expect((await t.http().post('/auth/login').send({ email: s.email, password: s.password })).status).toBe(401); // old password is dead
    await login(t, s.email, 'Brand-new-passw0rd');
    const stored = await t.db.selectFrom('auditLogs').selectAll().where('action', '=', 'auth.password_changed').execute();
    expect(stored.length).toBeGreaterThan(0);
    expect(JSON.stringify(stored)).not.toContain('Brand-new-passw0rd');
  });
});
