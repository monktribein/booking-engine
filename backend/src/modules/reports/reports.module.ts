import { Controller, Get, Injectable, Module, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsOptional } from 'class-validator';
import { sql } from 'kysely';
import { Permission } from '../../common/access/permissions';
import { PropertyAccess } from '../../common/access/property-access.decorator';
import { DateRangeQueryDto, IsDateOnly } from '../../common/dto';
import { ApiEnvelope, ApiStandardErrors } from '../../common/swagger';
import { ParseUuidPipe } from '../../common/utils';
import { addDays, eachNight, formatDateOnly, todayIn, toDateOnly } from '../../database/common/dates';
import { ChannelConnectionStatus, ReservationStatus, SyncJobStatus } from '../../database/enums';
import { DomainValidationError, NotFoundError } from '../../database/errors';
import { Db, InjectDb } from '../../database/kysely';
import { d } from '../../database/sql';

class OccupancyRowDto {
  @ApiProperty() date!: string;
  @ApiProperty() total!: number;
  @ApiProperty() sold!: number;
  @ApiProperty() blocked!: number;
  @ApiProperty() occupancyPct!: number;
}

class RevenueRowDto {
  @ApiProperty() source!: string;
  @ApiProperty() bookings!: number;
  @ApiProperty() roomNights!: number;
  @ApiProperty() revenue!: number;
  @ApiProperty({ description: 'Average daily rate (room revenue / room nights)' }) adr!: number;
}

class RevenueReportDto {
  @ApiProperty() currency!: string;
  @ApiProperty({ type: [RevenueRowDto] }) bySource!: RevenueRowDto[];
  @ApiProperty() totalRevenue!: number;
  @ApiProperty({ description: 'Revenue per available room-night' }) revPar!: number;
}

/**
 * Statuses whose room revenue is counted. PENDING (an unpaid hold that can still expire) and CANCELLED are not revenue.
 * NO_SHOW stays counted as before: there is no no-show-fee model, so the booked value is reported as booked.
 */
export const REVENUE_STATUSES = [ReservationStatus.CONFIRMED, ReservationStatus.CHECKED_IN, ReservationStatus.CHECKED_OUT, ReservationStatus.NO_SHOW];

export class DashboardQueryDto {
  @ApiPropertyOptional({ example: '2026-10-19', description: "Calendar date in the property's time zone; defaults to today there" })
  @IsOptional()
  @IsDateOnly()
  date?: string;
}

class DashboardAlertDto {
  @ApiProperty({ enum: ['warning', 'error'] }) severity!: string;
  @ApiProperty() code!: string;
  @ApiProperty() message!: string;
  @ApiProperty() count!: number;
}

class DashboardDto {
  @ApiProperty() date!: string;
  @ApiProperty() timezone!: string;
  @ApiProperty() currency!: string;
  @ApiProperty({ description: 'Physical rooms of the property that are not out of service on the date: sum of inventory total' }) totalRooms!: number;
  @ApiProperty({ description: 'total minus rooms blocked for maintenance or events' }) sellableRooms!: number;
  @ApiProperty({ description: 'Rooms taken by confirmed, in-house or unpaid-hold reservations (inventory sold)' }) soldRooms!: number;
  @ApiProperty({ description: 'Part of soldRooms that is an unpaid, unexpired hold' }) heldRooms!: number;
  @ApiProperty({ description: 'sellableRooms - soldRooms, never below zero' }) availableRooms!: number;
  @ApiProperty({ description: 'soldRooms / sellableRooms, one decimal; 0 when nothing is sellable' }) occupancyPercent!: number;
  @ApiProperty({ description: 'Stays arriving on the date that are confirmed, checked in or checked out' }) arrivals!: number;
  @ApiProperty({ description: 'Arrivals still to be checked in' }) arrivalsPending!: number;
  @ApiProperty({ description: 'Departures on the date that are checked in or checked out' }) departures!: number;
  @ApiProperty({ description: 'Departures still to be checked out' }) departuresPending!: number;
  @ApiProperty({ description: 'Room revenue (minor units, net of discount, excluding tax) of CONFIRMED / CHECKED_IN / CHECKED_OUT / NO_SHOW stays arriving on the date' }) arrivalsRevenue!: number;
  @ApiProperty({ type: [DashboardAlertDto] }) alerts!: DashboardAlertDto[];
}

@Injectable()
export class ReportsService {
  constructor(@InjectDb() private readonly db: Db) {}

  private range(q: DateRangeQueryDto) {
    const from = toDateOnly(q.from);
    const to = toDateOnly(q.to);
    const n = eachNight(from, to).length;
    if (n < 1 || n > 366) throw new DomainValidationError('Range must be 1..366 days');
    return { from, to };
  }

  async occupancy(propertyId: string, q: DateRangeQueryDto) {
    const { from, to } = this.range(q);
    const rows = await this.db
      .selectFrom('inventory')
      .select(['date', sql<string>`sum(total)`.as('total'), sql<string>`sum(sold)`.as('sold'), sql<string>`sum(blocked)`.as('blocked')])
      .where('propertyId', '=', propertyId)
      .where('date', '>=', d(from))
      .where('date', '<', d(to))
      .groupBy('date')
      .orderBy('date')
      .execute();
    return rows.map((r) => {
      const total = Number(r.total);
      const sold = Number(r.sold);
      const blocked = Number(r.blocked);
      return { date: formatDateOnly(r.date), total, sold, blocked, occupancyPct: total > blocked ? Math.round((sold / (total - blocked)) * 1000) / 10 : 0 };
    });
  }

  /** Revenue of stays arriving in [from, to), by source: confirmed, in-house, completed and no-show stays; net of discount, excluding tax. */
  async revenue(propertyId: string, q: DateRangeQueryDto) {
    const { from, to } = this.range(q);
    const [property, bySource, capacity] = await Promise.all([
      this.db.selectFrom('properties').select('currency').where('id', '=', propertyId).executeTakeFirst(),
      this.db
        .selectFrom('reservations as r')
        .select([
          'r.source',
          sql<string>`count(*)`.as('bookings'),
          sql<string>`coalesce(sum(r.subtotal - r.discount), 0)`.as('revenue'),
          sql<string>`coalesce(sum(r.nights * (select coalesce(sum(rr.quantity), 0) from reservation_rooms rr where rr.reservation_id = r.id)), 0)`.as('roomNights'),
        ])
        .where('r.propertyId', '=', propertyId)
        .where('r.checkIn', '>=', d(from))
        .where('r.checkIn', '<', d(to))
        .where('r.status', 'in', REVENUE_STATUSES)
        .groupBy('r.source')
        .orderBy(sql`sum(r.subtotal - r.discount)`, 'desc')
        .execute(),
      this.db.selectFrom('inventory').select(sql<string>`coalesce(sum(total), 0)`.as('n')).where('propertyId', '=', propertyId).where('date', '>=', d(from)).where('date', '<', d(to)).executeTakeFirstOrThrow(),
    ]);
    const rows = bySource.map((r) => ({ source: r.source, bookings: Number(r.bookings), revenue: Number(r.revenue), roomNights: Number(r.roomNights) }));
    const totalRevenue = rows.reduce((a, r) => a + r.revenue, 0);
    const availableRoomNights = Number(capacity.n);
    return {
      currency: property?.currency,
      bySource: rows.map((r) => ({ ...r, adr: r.roomNights ? Math.round(r.revenue / r.roomNights) : 0 })),
      totalRevenue,
      revPar: availableRoomNights ? Math.round(totalRevenue / availableRoomNights) : 0,
    };
  }

  /**
   * One authoritative snapshot for the dashboard. "Today" is the property's own calendar day, not the browser's or the
   * server's, so a manager in another time zone sees the same numbers as the front desk. Every figure is a query over stored
   * records; nothing is estimated.
   */
  async dashboard(propertyId: string, q: DashboardQueryDto) {
    const property = await this.db.selectFrom('properties').select(['timezone', 'currency']).where('id', '=', propertyId).executeTakeFirst();
    if (!property) throw new NotFoundError('Property', propertyId);
    const date = q.date ? toDateOnly(q.date) : todayIn(property.timezone);
    const next = addDays(date, 1);
    const yesterdayCutoff = new Date(Date.now() - 24 * 3_600_000);

    const [inv, arrivalRows, departureRows, held, unassigned, overdue, connections, failedSync, revenue] = await Promise.all([
      this.db
        .selectFrom('inventory')
        .select([sql<string>`coalesce(sum(total), 0)`.as('total'), sql<string>`coalesce(sum(sold), 0)`.as('sold'), sql<string>`coalesce(sum(blocked), 0)`.as('blocked')])
        .where('propertyId', '=', propertyId)
        .where('date', '=', d(date))
        .executeTakeFirstOrThrow(),
      this.db.selectFrom('reservations').select(['status', sql<string>`count(*)`.as('n')]).where('propertyId', '=', propertyId).where('checkIn', '=', d(date)).groupBy('status').execute(),
      this.db.selectFrom('reservations').select(['status', sql<string>`count(*)`.as('n')]).where('propertyId', '=', propertyId).where('checkOut', '=', d(date)).groupBy('status').execute(),
      this.db
        .selectFrom('reservations as r')
        .innerJoin('reservationRooms as rr', 'rr.reservationId', 'r.id')
        .select(sql<string>`coalesce(sum(rr.quantity), 0)`.as('n'))
        .where('r.propertyId', '=', propertyId)
        .where('r.status', '=', ReservationStatus.PENDING)
        .where('r.checkIn', '<=', d(date))
        .where('r.checkOut', '>', d(date))
        .executeTakeFirstOrThrow(),
      this.db
        .selectFrom('reservations as r')
        .select(sql<string>`count(distinct r.id)`.as('n'))
        .where('r.propertyId', '=', propertyId)
        .where('r.checkIn', '=', d(date))
        .where('r.status', '=', ReservationStatus.CONFIRMED)
        .where(sql<boolean>`exists (select 1 from reservation_rooms rr where rr.reservation_id = r.id and rr.room_id is null)`)
        .executeTakeFirstOrThrow(),
      this.db
        .selectFrom('reservations')
        .select(sql<string>`count(*)`.as('n'))
        .where('propertyId', '=', propertyId)
        .where('status', '=', ReservationStatus.CHECKED_IN)
        .where('checkOut', '<', d(date))
        .executeTakeFirstOrThrow(),
      this.db.selectFrom('channelConnections').select(['channel', 'status', 'lastError']).where('propertyId', '=', propertyId).execute(),
      this.db
        .selectFrom('syncJobs')
        .select(sql<string>`count(*)`.as('n'))
        .where('propertyId', '=', propertyId)
        .where('status', '=', SyncJobStatus.FAILED)
        .where('updatedAt', '>=', yesterdayCutoff)
        .executeTakeFirstOrThrow(),
      this.revenue(propertyId, { from: formatDateOnly(date), to: formatDateOnly(next) }),
    ]);

    const byStatus = (rows: { status: string; n: string }[], ...statuses: string[]) => rows.filter((r) => statuses.includes(r.status)).reduce((a, r) => a + Number(r.n), 0);
    const totalRooms = Number(inv.total);
    const blocked = Number(inv.blocked);
    const sellableRooms = Math.max(0, totalRooms - blocked);
    const soldRooms = Number(inv.sold);
    const alerts: { severity: 'warning' | 'error'; code: string; message: string; count: number }[] = [];
    const channelProblems = connections.filter((c) => c.status === ChannelConnectionStatus.ERROR || c.status === ChannelConnectionStatus.EXPIRED || (c.status === ChannelConnectionStatus.CONNECTED && c.lastError));
    if (channelProblems.length) alerts.push({ severity: 'error', code: 'CHANNEL_ERROR', message: `${channelProblems.length} channel connection(s) report an error or expired credentials`, count: channelProblems.length });
    if (Number(failedSync.n)) alerts.push({ severity: 'error', code: 'SYNC_FAILED', message: 'Channel synchronisation jobs failed permanently in the last 24 hours', count: Number(failedSync.n) });
    if (Number(unassigned.n)) alerts.push({ severity: 'warning', code: 'UNASSIGNED_ARRIVALS', message: 'Arriving reservations have no room assigned yet', count: Number(unassigned.n) });
    if (Number(overdue.n)) alerts.push({ severity: 'warning', code: 'OVERDUE_DEPARTURES', message: 'Guests are still checked in after their check-out date', count: Number(overdue.n) });

    return {
      date: formatDateOnly(date),
      timezone: property.timezone,
      currency: property.currency,
      totalRooms,
      sellableRooms,
      soldRooms,
      heldRooms: Number(held.n),
      availableRooms: Math.max(0, sellableRooms - soldRooms),
      occupancyPercent: sellableRooms > 0 ? Math.round((soldRooms / sellableRooms) * 1000) / 10 : 0,
      arrivals: byStatus(arrivalRows, ReservationStatus.CONFIRMED, ReservationStatus.CHECKED_IN, ReservationStatus.CHECKED_OUT),
      arrivalsPending: byStatus(arrivalRows, ReservationStatus.CONFIRMED),
      departures: byStatus(departureRows, ReservationStatus.CHECKED_IN, ReservationStatus.CHECKED_OUT),
      departuresPending: byStatus(departureRows, ReservationStatus.CHECKED_IN),
      arrivalsRevenue: revenue.totalRevenue,
      alerts,
    };
  }
}

@ApiTags('Reports')
@Controller('properties/:propertyId/reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('dashboard')
  @PropertyAccess(Permission.REPORTS_VIEW, { in: 'param', key: 'propertyId', entity: 'property' })
  @ApiOperation({ summary: "Dashboard snapshot for one calendar day in the property's time zone (defaults to today there)" })
  @ApiEnvelope(DashboardDto)
  @ApiStandardErrors({ notFound: true })
  dashboard(@Param('propertyId', ParseUuidPipe) propertyId: string, @Query() q: DashboardQueryDto) {
    return this.reports.dashboard(propertyId, q);
  }

  @Get('occupancy')
  @PropertyAccess(Permission.REPORTS_VIEW, { in: 'param', key: 'propertyId', entity: 'property' })
  @ApiOperation({ summary: 'Nightly occupancy (sold / sellable rooms)' })
  @ApiEnvelope(OccupancyRowDto, { isArray: true })
  @ApiStandardErrors({ notFound: true })
  occupancy(@Param('propertyId', ParseUuidPipe) propertyId: string, @Query() q: DateRangeQueryDto) {
    return this.reports.occupancy(propertyId, q);
  }

  @Get('revenue')
  @PropertyAccess(Permission.REPORTS_VIEW, { in: 'param', key: 'propertyId', entity: 'property' })
  @ApiOperation({ summary: 'Room revenue by source with ADR and RevPAR (net of discounts, excluding tax)' })
  @ApiEnvelope(RevenueReportDto)
  @ApiStandardErrors({ notFound: true })
  revenue(@Param('propertyId', ParseUuidPipe) propertyId: string, @Query() q: DateRangeQueryDto) {
    return this.reports.revenue(propertyId, q);
  }
}

@Module({ controllers: [ReportsController], providers: [ReportsService] })
export class ReportsModule {}
