import { createHash } from 'node:crypto';
import { exampleRestDefinition } from '../src/modules/channels/providers/example-definition';
import { stableStringify } from '../src/modules/channels/providers/provider.service';
import { bearer, createPlatformAdmin, createPropertyWithRooms, registerOwner } from './utils/fixtures';
import { createTestApp } from './utils/test-app';

/** The feature flag and the production-style network rules: the framework is inert when off and refuses private targets when on. */
describe('Configuration-driven providers: rollout flag and network policy', () => {
  it('with CHANNEL_PROVIDERS_ENABLED off, only the built-in adapters exist and configured providers cannot be used', async () => {
    const t = await createTestApp({ CHANNEL_PROVIDERS_ENABLED: 'false', WEBHOOK_ALLOW_PRIVATE_TARGETS: 'false' });
    try {
      const owner = await registerOwner(t);
      const s = await createPropertyWithRooms(t, owner.token, 2);
      // a provider that is fully published in the database (as if the flag had been on earlier)
      const def = exampleRestDefinition({ baseUrl: 'https://api.acme-stay.example.com', host: 'api.acme-stay.example.com' });
      const provider = await t.db.insertInto('channelProviders').values({ code: 'ACME_STAY', name: 'Acme Stay', kind: 'PMS', protocol: 'REST_JSON', status: 'ACTIVE' }).returning('id').executeTakeFirstOrThrow();
      const hash = createHash('sha256').update(stableStringify(def)).digest('hex');
      const version = await t.db
        .insertInto('channelProviderVersions')
        .values({ providerId: provider.id, version: 1, status: 'PUBLISHED', definition: JSON.stringify(def) as never, definitionHash: hash, publishedAt: new Date() })
        .returning('id')
        .executeTakeFirstOrThrow();
      await t.db.updateTable('channelProviders').set({ currentVersionId: version.id }).where('id', '=', provider.id).execute();

      const list = await t.http().get(`/properties/${s.propertyId}/channels`).set(bearer(owner.token)).expect(200);
      expect(list.body.data.map((c: { channel: string }) => c.channel)).not.toContain('ACME_STAY');
      const connect = await t.http().post(`/properties/${s.propertyId}/channels/ACME_STAY/credentials`).set(bearer(owner.token)).send({ credentials: { API_KEY: 'k' } });
      expect(connect.status).toBe(422);
      expect(connect.body.error.code).toBe('CHANNEL_INTEGRATION_NOT_AVAILABLE');
      expect((await t.http().post('/webhooks/c/' + 'a'.repeat(43)).send({})).status).toBe(404);
      // built-ins behave as before
      const airbnb = await t.http().post(`/properties/${s.propertyId}/channels/AIRBNB/connect`).set(bearer(owner.token));
      expect(airbnb.body.error.code).toBe('CHANNEL_INTEGRATION_NOT_AVAILABLE');
      const unknown = await t.http().post(`/properties/${s.propertyId}/channels/NOT_A_CHANNEL/connect`).set(bearer(owner.token));
      expect(unknown.status).toBe(404);
    } finally {
      await t.close();
    }
  });

  it('with private targets disabled (as in production) a definition aimed at a local or private host cannot even be validated', async () => {
    const t = await createTestApp({ CHANNEL_PROVIDERS_ENABLED: 'true', WEBHOOK_ALLOW_PRIVATE_TARGETS: 'false' });
    try {
      const admin = await createPlatformAdmin(t, 'SUPER_ADMIN', 'root');
      for (const target of ['http://127.0.0.1:9000', 'https://localhost', 'https://169.254.169.254', 'https://10.1.2.3', 'https://metadata.internal']) {
        const host = new URL(target).hostname;
        const res = await t.http().post('/admin/channel-providers/validate').set(bearer(admin.token)).send({ definition: exampleRestDefinition({ baseUrl: target, host }) }).expect(200);
        expect({ target, ok: res.body.data.ok }).toEqual({ target, ok: false });
      }
      // and calendar feeds may only be public https addresses (they are fetched by the server)
      const owner = await registerOwner(t);
      const s = await createPropertyWithRooms(t, owner.token, 1);
      for (const url of ['http://example.com/cal.ics', 'https://127.0.0.1/cal.ics', 'https://localhost/cal.ics', 'https://10.0.0.5/cal.ics', 'https://169.254.169.254/latest', 'https://user:pw@example.com/cal.ics', 'https://intranet/cal.ics', 'file:///etc/passwd', 'ftp://example.com/cal.ics']) {
        const res = await t.http().post(`/properties/${s.propertyId}/channels/ICAL/credentials`).set(bearer(owner.token)).send({ feeds: [{ name: 'x', url }] });
        expect({ url, status: res.status }).toEqual({ url, status: 400 });
      }
      const good = await t.http().post('/admin/channel-providers/validate').set(bearer(admin.token)).send({ definition: exampleRestDefinition({ baseUrl: 'https://api.acme-stay.example.com', host: 'api.acme-stay.example.com' }) }).expect(200);
      expect(good.body.data.ok).toBe(true);
    } finally {
      await t.close();
    }
  });
});
