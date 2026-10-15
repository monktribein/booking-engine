import { AddressInfo } from 'node:net';
import { SMTPServer } from 'smtp-server';
import { JobHandlerRegistry } from '../src/jobs/job-handler';
import { bearer, createPropertyWithRooms, day, registerOwner, reservationBody, PropertySetup, Session } from './utils/fixtures';
import { createTestApp, TestApp } from './utils/test-app';

/**
 * E-mail delivery through the SMTP provider, against a local in-process SMTP server (127.0.0.1, random port):
 * nothing can leave the machine. Works with both queue drivers.
 */
describe('Notifications over SMTP (local test server)', () => {
  const inbox: { to: string[]; raw: string }[] = [];
  let rejectWith: number | null = null; // when set, RCPT TO is refused with this SMTP code
  let server: SMTPServer;
  let t: TestApp;
  let owner: Session;
  let s: PropertySetup;
  let n = 0;

  beforeAll(async () => {
    server = new SMTPServer({
      authOptional: true,
      disabledCommands: ['STARTTLS'],
      logger: false,
      onRcptTo(address, _session, cb) {
        if (rejectWith) return cb(Object.assign(new Error('Mailbox unavailable'), { responseCode: rejectWith }));
        cb();
      },
      onData(stream, session, cb) {
        const chunks: Buffer[] = [];
        stream.on('data', (c) => chunks.push(c));
        stream.on('end', () => {
          inbox.push({ to: session.envelope.rcptTo.map((r) => r.address), raw: Buffer.concat(chunks).toString('utf8') });
          cb();
        });
      },
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.server.address() as AddressInfo).port;
    t = await createTestApp({ SMTP_URL: `smtp://127.0.0.1:${port}`, SMTP_FROM: 'Radha Ashram <bookings@radha.example>' });
    owner = await registerOwner(t);
    s = await createPropertyWithRooms(t, owner.token, 6);
  });
  afterAll(async () => {
    await t.close();
    await new Promise((r) => server.close(() => r(null)));
  });

  const book = (email: string) =>
    t.http().post('/reservations').set(bearer(owner.token)).send(reservationBody(s, day(3 + 2 * ++n), day(4 + 2 * n), { guest: { firstName: 'Priya', lastName: 'Sharma', email } })).expect(201);

  it('a guest e-mail is delivered once to the SMTP server with the right sender, recipient and a deterministic Message-ID', async () => {
    const email = `guest-${Date.now()}@example.com`;
    const res = await book(email);
    await t.drain();
    const mails = inbox.filter((m) => m.to.includes(email));
    expect(mails.length).toBeGreaterThanOrEqual(1);
    const mail = mails[0];
    expect(mail.raw).toMatch(/From: .*bookings@radha\.example/i);
    expect(mail.raw).toContain(res.body.data.reservationCode); // the booking code is in the message
    const rows = await t.db.selectFrom('notifications').selectAll().where('recipient', '=', email).orderBy('createdAt').execute();
    expect(rows.length).toBe(mails.length);
    expect(rows.every((r) => r.status === 'SENT' && r.attempts === 1)).toBe(true);
    expect((rows[0].metadata as { providerMessageId: string }).providerMessageId).toMatch(new RegExp(`^<ntf-${rows[0].id}@radha\\.example>$`));
    expect(mail.raw).toContain(`Message-ID: <ntf-${rows[0].id}@radha.example>`);
  });

  it('re-delivering the same notification job sends nothing more (idempotent)', async () => {
    const email = `again-${Date.now()}@example.com`;
    await book(email);
    await t.drain();
    const before = inbox.filter((m) => m.to.includes(email)).length;
    const row = await t.db.selectFrom('notifications').selectAll().where('recipient', '=', email).executeTakeFirst();
    const handler = t.app.get(JobHandlerRegistry).get('notification');
    const out = await handler.handle({ id: 'replay', name: 'send', data: { notificationId: row!.id }, attemptsMade: 0, maxAttempts: 5 } as never);
    expect(out).toMatchObject({ status: 'SKIPPED_ALREADY_HANDLED' });
    expect(inbox.filter((m) => m.to.includes(email)).length).toBe(before);
  });

  it('a permanent SMTP refusal (550) marks the notification FAILED without retrying', async () => {
    const email = `nobody-${Date.now()}@example.com`;
    rejectWith = 550;
    try {
      await book(email);
      await t.drain();
    } finally {
      rejectWith = null;
    }
    const row = await t.db.selectFrom('notifications').selectAll().where('recipient', '=', email).executeTakeFirst();
    expect(row).toMatchObject({ status: 'FAILED', attempts: 1 });
    expect(row!.lastError).toMatch(/550/);
    expect(inbox.some((m) => m.to.includes(email))).toBe(false);
  });

  it('a temporary SMTP error (451) is retried and then delivered', async () => {
    const email = `later-${Date.now()}@example.com`;
    rejectWith = 451;
    setTimeout(() => (rejectWith = null), 400); // the mail server recovers while the job is backing off
    await book(email);
    await t.drain();
    rejectWith = null;
    const row = await t.db.selectFrom('notifications').selectAll().where('recipient', '=', email).executeTakeFirst();
    expect(row).toMatchObject({ status: 'SENT' });
    expect(row!.attempts).toBeGreaterThanOrEqual(2);
    expect(inbox.filter((m) => m.to.includes(email))).toHaveLength(1);
  });
});
