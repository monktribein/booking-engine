import { Controller, Get, Injectable, Module, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { sql } from 'kysely';
import { Permission } from '../../common/access/permissions';
import { PropertyAccess } from '../../common/access/property-access.decorator';
import { DateRangeQueryDto } from '../../common/dto';
import { ApiEnvelope, ApiStandardErrors } from '../../common/swagger';
import { ParseUuidPipe } from '../../common/utils';
import { eachNight, formatDateOnly, toDateOnly } from '../../database/common/dates';
import { ReservationStatus } from '../../database/enums';
import { DomainValidationError } from '../../database/errors';
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

  /** Revenue of stays arriving in [from, to), by source, excluding cancellations. */
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
        .where('r.status', '!=', ReservationStatus.CANCELLED)
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
}

@ApiTags('Reports')
@Controller('properties/:propertyId/reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

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
