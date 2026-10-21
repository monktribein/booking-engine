import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import type { AuthUser, RequestMeta } from '../../common/auth/auth-user';
import { toUuid } from '../../common/utils';
import { eachNight, formatDateOnly, nightsBetween, toDateOnly } from '../../database/common/dates';
import { nightlyRate, pickRule, rulesCollide } from '../../database/common/pricing';
import type { RateRule } from '../../database/db-types';
import { RateAdjustment, RatePlanStatus, RateRuleStatus, SyncEntityType, SyncJobType } from '../../database/enums';
import { ConflictError, DomainValidationError, NotFoundError } from '../../database/errors';
import { Db, InjectDb, runInTransaction } from '../../database/kysely';
import { loadRateRules } from '../../database/services/rate-engine';
import { SyncJobService } from '../../database/services/sync-job.service';
import { OutboxDispatcher } from '../../jobs/outbox.dispatcher';
import { AuditLogger } from '../audit/audit.logger';
import type { CreateRateRuleDto, RateCalendarQueryDto, UpdateRateRuleDto } from './rates.dto';

interface RuleShape {
  ratePlanId: string | null;
  startDate: Date;
  endDate: Date;
  daysOfWeek: number[] | null;
  adjustment: RateAdjustment;
  amount: number | null;
  percent: number | null;
  priority: number;
}

/**
 * Date-level and seasonal prices. A rule never edits a rate plan or an existing reservation: reservations freeze the price they
 * were sold at, and the rules only decide what a night costs for bookings made (or nights added) from now on. See
 * database/common/pricing.ts for the calculation order and which rule wins.
 */
@Injectable()
export class RateRulesService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly syncJobs: SyncJobService,
    private readonly outbox: OutboxDispatcher,
    private readonly audit: AuditLogger,
  ) {}

  list(propertyId: string, roomTypeId?: string): Promise<RateRule[]> {
    let q = this.db.selectFrom('rateRules').selectAll().where('propertyId', '=', propertyId);
    if (roomTypeId) q = q.where('roomTypeId', '=', toUuid(roomTypeId, 'roomTypeId'));
    return q.orderBy('startDate').orderBy('priority', 'desc').execute();
  }

  async create(user: AuthUser, meta: RequestMeta, propertyId: string, dto: CreateRateRuleDto): Promise<RateRule> {
    const roomTypeId = toUuid(dto.roomTypeId, 'roomTypeId');
    const shape = this.shape(dto);
    const rule = await runInTransaction(this.db, async (tx) => {
      await this.assertScope(tx, propertyId, roomTypeId, shape.ratePlanId);
      await this.assertNoCollision(tx, propertyId, roomTypeId, shape);
      return tx
        .insertInto('rateRules')
        .values({
          propertyId,
          roomTypeId,
          ratePlanId: shape.ratePlanId,
          name: dto.name.trim(),
          startDate: formatDateOnly(shape.startDate),
          endDate: formatDateOnly(shape.endDate),
          daysOfWeek: shape.daysOfWeek,
          adjustment: shape.adjustment,
          amount: shape.amount,
          percent: shape.percent,
          priority: shape.priority,
          createdBy: user.userId,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    });
    await this.afterChange(rule, rule.startDate, rule.endDate, user, meta, 'rate_rule.create');
    return rule;
  }

  async update(user: AuthUser, meta: RequestMeta, id: string, dto: UpdateRateRuleDto): Promise<RateRule> {
    const current = await this.db.selectFrom('rateRules').selectAll().where('id', '=', id).executeTakeFirst();
    if (!current) throw new NotFoundError('RateRule', id);
    const kindChanged = dto.adjustment !== undefined && dto.adjustment !== current.adjustment;
    const shape = this.shape({
      ratePlanId: dto.ratePlanId ?? current.ratePlanId,
      startDate: dto.startDate ?? formatDateOnly(current.startDate),
      endDate: dto.endDate ?? formatDateOnly(current.endDate),
      daysOfWeek: dto.daysOfWeek ?? current.daysOfWeek,
      adjustment: dto.adjustment ?? (current.adjustment as RateAdjustment),
      // Changing the kind of adjustment starts from the new kind's own value, never a leftover from the old one.
      amount: kindChanged ? dto.amount : (dto.amount ?? current.amount),
      percent: kindChanged ? dto.percent : (dto.percent ?? current.percent),
      priority: dto.priority ?? current.priority,
    });
    const status = dto.status ?? (current.status as RateRuleStatus);
    const updated = await runInTransaction(this.db, async (tx) => {
      await this.assertScope(tx, current.propertyId, current.roomTypeId, shape.ratePlanId);
      if (status === RateRuleStatus.ACTIVE) await this.assertNoCollision(tx, current.propertyId, current.roomTypeId, shape, id);
      return tx
        .updateTable('rateRules')
        .set({
          ratePlanId: shape.ratePlanId,
          name: (dto.name ?? current.name).trim(),
          startDate: formatDateOnly(shape.startDate),
          endDate: formatDateOnly(shape.endDate),
          daysOfWeek: shape.daysOfWeek,
          adjustment: shape.adjustment,
          amount: shape.amount,
          percent: shape.percent,
          priority: shape.priority,
          status,
        })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();
    });
    // Both the old and the new date range may have changed price.
    const from = new Date(Math.min(current.startDate.getTime(), updated.startDate.getTime()));
    const to = new Date(Math.max(current.endDate.getTime(), updated.endDate.getTime()));
    await this.afterChange(updated, from, to, user, meta, 'rate_rule.update');
    return updated;
  }

  /** Deactivates the rule. It stays listed, so the reason a past night cost what it did is not lost. */
  async deactivate(user: AuthUser, meta: RequestMeta, id: string): Promise<RateRule> {
    const rule = await this.db.updateTable('rateRules').set({ status: RateRuleStatus.INACTIVE }).where('id', '=', id).returningAll().executeTakeFirst();
    if (!rule) throw new NotFoundError('RateRule', id);
    await this.afterChange(rule, rule.startDate, rule.endDate, user, meta, 'rate_rule.deactivate');
    return rule;
  }

  /** The effective nightly price per date for one rate plan and the rule that set it. Read-only: exactly what a quote would use. */
  async calendar(propertyId: string, q: RateCalendarQueryDto) {
    const roomTypeId = toUuid(q.roomTypeId, 'roomTypeId');
    const from = toDateOnly(q.from);
    const to = toDateOnly(q.to);
    const nights = eachNight(from, to);
    if (!nights.length || nights.length > 366) throw new DomainValidationError('The window must be 1..366 days');
    const rt = await this.db.selectFrom('roomTypes').select('id').where('id', '=', roomTypeId).where('propertyId', '=', propertyId).executeTakeFirst();
    if (!rt) throw new NotFoundError('RoomType', roomTypeId);
    let planQuery = this.db.selectFrom('ratePlans').select(['id', 'basePrice']).where('roomTypeId', '=', roomTypeId).where('propertyId', '=', propertyId).where('status', '=', RatePlanStatus.ACTIVE);
    planQuery = q.ratePlanId ? planQuery.where('id', '=', toUuid(q.ratePlanId, 'ratePlanId')) : planQuery.orderBy('basePrice');
    const plan = await planQuery.limit(1).executeTakeFirst();
    if (!plan) throw new NotFoundError('RatePlan', q.ratePlanId ?? 'active rate plan');
    const [rules, names] = await Promise.all([
      loadRateRules(this.db, propertyId, [roomTypeId], from, to),
      this.db.selectFrom('rateRules').select(['id', 'name']).where('roomTypeId', '=', roomTypeId).execute(),
    ]);
    const nameOf = new Map(names.map((n) => [n.id, n.name]));
    return nights.map((night) => {
      const rule = pickRule(rules, night, plan.id);
      return { date: formatDateOnly(night), base: plan.basePrice, rate: nightlyRate(plan.basePrice, rule), ruleId: rule?.id ?? null, ruleName: rule ? (nameOf.get(rule.id) ?? null) : null };
    });
  }

  private shape(dto: {
    ratePlanId?: string | null;
    startDate: string;
    endDate: string;
    daysOfWeek?: number[] | null;
    adjustment: RateAdjustment;
    amount?: number | null;
    percent?: number | null;
    priority?: number;
  }): RuleShape {
    const startDate = toDateOnly(dto.startDate);
    const endDate = toDateOnly(dto.endDate);
    if (nightsBetween(startDate, endDate) < 1) throw new DomainValidationError('endDate must be after startDate');
    if (nightsBetween(startDate, endDate) > 1100) throw new DomainValidationError('A rule can cover at most 1100 nights');
    const days = dto.daysOfWeek?.length ? [...new Set(dto.daysOfWeek)].sort((a, b) => a - b) : null;
    if (dto.adjustment === RateAdjustment.FIXED) {
      if (dto.amount === undefined || dto.amount === null) throw new DomainValidationError('A FIXED rule needs amount (minor units)');
      if (dto.percent !== undefined && dto.percent !== null) throw new DomainValidationError('A FIXED rule cannot also set percent');
    } else {
      if (dto.percent === undefined || dto.percent === null) throw new DomainValidationError('A PERCENT rule needs percent');
      if (dto.amount !== undefined && dto.amount !== null) throw new DomainValidationError('A PERCENT rule cannot also set amount');
    }
    return {
      ratePlanId: dto.ratePlanId ? toUuid(dto.ratePlanId, 'ratePlanId') : null,
      startDate,
      endDate,
      daysOfWeek: days,
      adjustment: dto.adjustment,
      amount: dto.adjustment === RateAdjustment.FIXED ? (dto.amount as number) : null,
      percent: dto.adjustment === RateAdjustment.PERCENT ? Number(dto.percent) : null,
      priority: dto.priority ?? 0,
    };
  }

  private async assertScope(tx: Db, propertyId: string, roomTypeId: string, ratePlanId: string | null) {
    const rt = await tx.selectFrom('roomTypes').select('id').where('id', '=', roomTypeId).where('propertyId', '=', propertyId).executeTakeFirst();
    if (!rt) throw new DomainValidationError('roomTypeId must belong to this property');
    if (ratePlanId) {
      const rp = await tx.selectFrom('ratePlans').select('id').where('id', '=', ratePlanId).where('roomTypeId', '=', roomTypeId).where('propertyId', '=', propertyId).executeTakeFirst();
      if (!rp) throw new DomainValidationError('ratePlanId must be a rate plan of this room type');
    }
  }

  /**
   * Two active rules with the same priority and scope that could both set the same night are ambiguous. The advisory lock makes
   * two concurrent writers for one room type queue, so the check cannot be raced.
   */
  private async assertNoCollision(tx: Db, propertyId: string, roomTypeId: string, shape: RuleShape, ignoreId?: string) {
    await sql`select pg_advisory_xact_lock(hashtext(${'rate_rules:' + roomTypeId}))`.execute(tx);
    const others = await loadRateRules(tx, propertyId, [roomTypeId], shape.startDate, shape.endDate);
    const clash = others.find((o) => o.id !== ignoreId && rulesCollide(o, shape));
    if (clash) {
      const row = await tx.selectFrom('rateRules').select('name').where('id', '=', clash.id).executeTakeFirst();
      throw new ConflictError(
        'RATE_RULE_CONFLICT',
        `Rule "${row?.name ?? clash.id}" already sets the price for some of these nights at the same priority. Change the dates, the days of the week or the priority.`,
      );
    }
  }

  private async afterChange(rule: RateRule, from: Date, to: Date, user: AuthUser, meta: RequestMeta, action: string) {
    await runInTransaction(this.db, async (tx) => {
      await this.syncJobs.enqueueForRoomType(tx, {
        propertyId: rule.propertyId,
        roomTypeId: rule.roomTypeId,
        types: [SyncJobType.RATES],
        dateFrom: from,
        dateTo: to,
        entityType: SyncEntityType.RATE_PLAN,
        entityId: rule.ratePlanId ?? rule.id,
      });
      await this.audit.log(
        { user, meta },
        { action, entityType: 'RateRule', entityId: rule.id, propertyId: rule.propertyId, after: { name: rule.name, adjustment: rule.adjustment, amount: rule.amount, percent: rule.percent, priority: rule.priority, status: rule.status } },
        tx,
      );
    });
    void this.outbox.flush();
  }
}
