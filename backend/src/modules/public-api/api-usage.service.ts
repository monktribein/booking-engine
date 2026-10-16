import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { sql } from 'kysely';
import { formatDateOnly } from '../../database/common/dates';
import { Db, InjectDb } from '../../database/kysely';
import { d } from '../../database/sql';

interface Counter {
  apiKeyId: string;
  day: string;
  requests: number;
  clientErrors: number;
  serverErrors: number;
  rateLimited: number;
}

/**
 * Per-key, per-day request counters for the developer dashboard. Counting every request with its own UPDATE would turn each
 * API read into a write, so counts are held in memory and flushed in one statement every few seconds (and on shutdown).
 * A crash can lose the last few seconds of counts; nothing else depends on them (rate limiting has its own store).
 */
@Injectable()
export class ApiUsageService implements OnModuleDestroy {
  private buffer = new Map<string, Counter>();
  private readonly timer = setInterval(() => void this.flush().catch(() => undefined), 5_000);

  constructor(@InjectDb() private readonly db: Db) {
    this.timer.unref();
  }

  /** Called once per finished API request that was authenticated with `apiKeyId`. */
  record(apiKeyId: string, status: number): void {
    const day = formatDateOnly(new Date());
    const k = `${apiKeyId}|${day}`;
    const c = this.buffer.get(k) ?? { apiKeyId, day, requests: 0, clientErrors: 0, serverErrors: 0, rateLimited: 0 };
    c.requests++;
    if (status === 429) c.rateLimited++;
    else if (status >= 500) c.serverErrors++;
    else if (status >= 400) c.clientErrors++;
    this.buffer.set(k, c);
  }

  async flush(): Promise<void> {
    if (!this.buffer.size) return;
    const rows = [...this.buffer.values()];
    this.buffer = new Map();
    try {
      await this.db
        .insertInto('apiKeyUsage')
        .values(rows.map((r) => ({ apiKeyId: r.apiKeyId, day: r.day, requests: r.requests, clientErrors: r.clientErrors, serverErrors: r.serverErrors, rateLimited: r.rateLimited })))
        .onConflict((oc) =>
          oc.columns(['apiKeyId', 'day']).doUpdateSet({
            requests: sql`api_key_usage.requests + excluded.requests`,
            clientErrors: sql`api_key_usage.client_errors + excluded.client_errors`,
            serverErrors: sql`api_key_usage.server_errors + excluded.server_errors`,
            rateLimited: sql`api_key_usage.rate_limited + excluded.rate_limited`,
          }),
        )
        .execute();
    } catch (err) {
      // A key deleted meanwhile (foreign key) or a database blip: drop these counts rather than break shutdown or the next flush.
      if ((err as { code?: string }).code !== '23503') for (const r of rows) this.buffer.set(`${r.apiKeyId}|${r.day}`, r);
    }
  }

  async onModuleDestroy() {
    clearInterval(this.timer);
    await this.flush().catch(() => undefined);
  }

  /** Daily counters of one key for the last `days` days (including today), oldest first. */
  async forKey(apiKeyId: string, days = 30) {
    await this.flush();
    const from = new Date(Date.now() - (days - 1) * 86_400_000);
    const rows = await this.db.selectFrom('apiKeyUsage').selectAll().where('apiKeyId', '=', apiKeyId).where('day', '>=', d(from)).orderBy('day').execute();
    return rows.map((r) => ({ day: formatDateOnly(r.day), requests: r.requests, clientErrors: r.clientErrors, serverErrors: r.serverErrors, rateLimited: r.rateLimited }));
  }

  /** Totals across all keys of an organization for the last `days` days. */
  async forOrganization(organizationId: string, days = 7) {
    await this.flush();
    const from = new Date(Date.now() - (days - 1) * 86_400_000);
    const r = await this.db
      .selectFrom('apiKeyUsage as u')
      .innerJoin('apiKeys as k', 'k.id', 'u.apiKeyId')
      .select([
        sql<string>`coalesce(sum(u.requests), 0)`.as('requests'),
        sql<string>`coalesce(sum(u.client_errors), 0)`.as('clientErrors'),
        sql<string>`coalesce(sum(u.server_errors), 0)`.as('serverErrors'),
        sql<string>`coalesce(sum(u.rate_limited), 0)`.as('rateLimited'),
      ])
      .where('k.organizationId', '=', organizationId)
      .where('u.day', '>=', d(from))
      .executeTakeFirstOrThrow();
    return { requests: Number(r.requests), clientErrors: Number(r.clientErrors), serverErrors: Number(r.serverErrors), rateLimited: Number(r.rateLimited) };
  }
}
