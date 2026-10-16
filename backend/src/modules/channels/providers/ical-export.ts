import { createHash, randomBytes } from 'node:crypto';
import { Body, Controller, Delete, Get, HttpCode, Injectable, Param, Post, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiExcludeEndpoint, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsOptional, IsString, IsUUID, Length } from 'class-validator';
import type { Response } from 'express';
import { Permission } from '../../../common/access/permissions';
import { PropertyAccess } from '../../../common/access/property-access.decorator';
import type { AuthUser, RequestMeta } from '../../../common/auth/auth-user';
import { CurrentUser, Public, ReqMeta, RequireActiveOrg } from '../../../common/decorators';
import { ApiStandardErrors } from '../../../common/swagger';
import { ParseUuidPipe } from '../../../common/utils';
import type { AppConfig } from '../../../config/configuration';
import { addDays, formatDateOnly, todayIn } from '../../../database/common/dates';
import { OrganizationStatus, PropertyStatus } from '../../../database/enums';
import { NotFoundError } from '../../../database/errors';
import { Db, InjectDb } from '../../../database/kysely';
import { AuditLogger } from '../../audit/audit.logger';
import { buildIcal } from './ical';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const onProperty = (p: Permission) => PropertyAccess(p, { in: 'param', key: 'propertyId', entity: 'property' });

/**
 * Availability calendars Tirvona PUBLISHES, for platforms that can import an iCal address. The feed marks the nights on which a room
 * type is sold out (or on stop-sell): that is all an iCal feed can say. It does not carry prices, guest names or the number of rooms
 * left, so for a room type with several units the other platform sees the type as available until the last unit is taken.
 * The address contains a random token (shown once, stored hashed), works like a password and can be revoked.
 */
@Injectable()
export class IcalExportService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly audit: AuditLogger,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  url(token: string): string {
    return `${this.config.get('apiUrl', { infer: true })}/ical/${token}.ics`;
  }

  async create(user: AuthUser, meta: RequestMeta, propertyId: string, roomTypeId: string, label?: string) {
    const rt = await this.db.selectFrom('roomTypes').select(['id', 'name']).where('id', '=', roomTypeId).where('propertyId', '=', propertyId).executeTakeFirst();
    if (!rt) throw new NotFoundError('Room type', roomTypeId);
    const token = randomBytes(32).toString('base64url');
    const row = await this.db
      .insertInto('icalExportFeeds')
      .values({ propertyId, roomTypeId, label: label?.trim().slice(0, 100) || null, tokenHash: sha256(token), createdBy: user.userId })
      .returning(['id', 'createdAt'])
      .executeTakeFirstOrThrow();
    await this.audit.log({ user, meta }, { action: 'ical.export_create', entityType: 'IcalExportFeed', entityId: row.id, propertyId, metadata: { roomTypeId } });
    return { id: row.id, roomTypeId, roomType: rt.name, label: label ?? null, createdAt: row.createdAt, url: this.url(token), note: 'This address is shown only now. Anyone who has it can read the calendar; revoke it to stop access.' };
  }

  async list(propertyId: string) {
    return this.db
      .selectFrom('icalExportFeeds as f')
      .innerJoin('roomTypes as r', 'r.id', 'f.roomTypeId')
      .select(['f.id', 'f.roomTypeId', 'r.name as roomType', 'f.label', 'f.createdAt', 'f.lastFetchedAt', 'f.revokedAt'])
      .where('f.propertyId', '=', propertyId)
      .orderBy('f.createdAt', 'desc')
      .execute();
  }

  async revoke(user: AuthUser, meta: RequestMeta, propertyId: string, feedId: string) {
    const row = await this.db.updateTable('icalExportFeeds').set({ revokedAt: new Date() }).where('id', '=', feedId).where('propertyId', '=', propertyId).where('revokedAt', 'is', null).returning('id').executeTakeFirst();
    if (!row) throw new NotFoundError('Calendar feed', feedId);
    await this.audit.log({ user, meta }, { action: 'ical.export_revoke', entityType: 'IcalExportFeed', entityId: feedId, propertyId });
    return { ok: true };
  }

  /** The calendar for a token, or null for anything that should look like "no such calendar". */
  async render(token: string): Promise<string | null> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const feed = await this.db.selectFrom('icalExportFeeds').selectAll().where('tokenHash', '=', sha256(token)).where('revokedAt', 'is', null).executeTakeFirst();
    if (!feed) return null;
    const property = await this.db
      .selectFrom('properties as p')
      .innerJoin('organizations as o', 'o.id', 'p.organizationId')
      .select(['p.name', 'p.timezone', 'p.bookingHorizonDays', 'p.status', 'o.status as orgStatus'])
      .where('p.id', '=', feed.propertyId)
      .executeTakeFirst();
    // A suspended partner or property publishes nothing.
    if (!property || property.orgStatus !== OrganizationStatus.ACTIVE || property.status === PropertyStatus.ARCHIVED || property.status === 'SUSPENDED') return null;
    const roomType = await this.db.selectFrom('roomTypes').select('name').where('id', '=', feed.roomTypeId).executeTakeFirst();
    const from = todayIn(property.timezone);
    const rows = await this.db
      .selectFrom('inventory')
      .select(['date', 'available', 'stopSell'])
      .where('propertyId', '=', feed.propertyId)
      .where('roomTypeId', '=', feed.roomTypeId)
      .where('date', '>=', formatDateOnly(addDays(from, -1)) as never)
      .where('date', '<=', formatDateOnly(addDays(from, property.bookingHorizonDays)) as never)
      .orderBy('date')
      .execute();
    const taken = rows.filter((r) => r.available <= 0 || r.stopSell).map((r) => (r.date instanceof Date ? r.date.toISOString().slice(0, 10) : String(r.date).slice(0, 10)));
    const events: { uid: string; start: string; end: string; summary: string }[] = [];
    let runStart: string | null = null;
    let prev: string | null = null;
    const next = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    const flush = () => {
      if (runStart && prev) events.push({ uid: `${feed.id}-${runStart}@tirvona`, start: runStart, end: next(prev), summary: 'Not available' });
    };
    for (const d of taken) {
      if (prev && next(prev) === d) {
        prev = d;
        continue;
      }
      flush();
      runStart = d;
      prev = d;
    }
    flush();
    // Bookkeeping must never make the feed fail, and a polling platform must not turn it into a write per request.
    if (!feed.lastFetchedAt || Date.now() - feed.lastFetchedAt.getTime() > 60_000) {
      void this.db.updateTable('icalExportFeeds').set({ lastFetchedAt: new Date() }).where('id', '=', feed.id).execute().catch(() => undefined);
    }
    return buildIcal({ name: `${property.name} — ${roomType?.name ?? 'Room'}`, events });
  }
}

class CreateFeedDto {
  @ApiProperty() @IsUUID() roomTypeId!: string;
  @ApiPropertyOptional({ example: 'For Airbnb' }) @IsOptional() @IsString() @Length(1, 100) label?: string;
}

@ApiTags('Channels')
@Controller('properties/:propertyId/ical-feeds')
export class IcalFeedsController {
  constructor(private readonly feeds: IcalExportService) {}

  @Get()
  @onProperty(Permission.CHANNELS_VIEW)
  @ApiOperation({ summary: 'Calendar addresses published for other platforms (never the address itself)' })
  @ApiStandardErrors({ notFound: true })
  list(@Param('propertyId', ParseUuidPipe) propertyId: string) {
    return this.feeds.list(propertyId);
  }

  @Post()
  @RequireActiveOrg()
  @onProperty(Permission.CHANNELS_MANAGE)
  @ApiOperation({ summary: 'Publish an availability calendar for one room type. The address is returned once.' })
  @ApiStandardErrors({ notFound: true })
  create(@CurrentUser() user: AuthUser, @ReqMeta() meta: RequestMeta, @Param('propertyId', ParseUuidPipe) propertyId: string, @Body() dto: CreateFeedDto) {
    return this.feeds.create(user, meta, propertyId, dto.roomTypeId, dto.label);
  }

  @Delete(':feedId')
  @HttpCode(200)
  @onProperty(Permission.CHANNELS_MANAGE)
  @ApiOperation({ summary: 'Revoke a calendar address' })
  @ApiStandardErrors({ notFound: true })
  revoke(@CurrentUser() user: AuthUser, @ReqMeta() meta: RequestMeta, @Param('propertyId', ParseUuidPipe) propertyId: string, @Param('feedId', ParseUuidPipe) feedId: string) {
    return this.feeds.revoke(user, meta, propertyId, feedId);
  }
}

/** The public calendar address. Raw text/calendar, not the JSON envelope. */
@Controller('ical')
export class IcalPublicController {
  constructor(private readonly feeds: IcalExportService) {}

  @Public()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get(':file')
  @ApiExcludeEndpoint()
  async calendar(@Param('file') file: string, @Res() res: Response) {
    const text = /^[A-Za-z0-9_-]{43}\.ics$/.test(file) ? await this.feeds.render(file.slice(0, -4)) : null;
    if (text === null) {
      res.status(404).type('text/plain').send('Not found');
      return;
    }
    res.status(200).set({ 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'private, max-age=300', 'X-Content-Type-Options': 'nosniff' }).send(text);
  }
}
