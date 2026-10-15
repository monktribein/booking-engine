import { Controller, Get, Injectable, Module, Param, Query } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { Connection, Types } from 'mongoose';
import { Permission } from '../../common/access/permissions';
import { PropertyAccess } from '../../common/access/property-access.decorator';
import { DateRangeQueryDto } from '../../common/dto';
import { ApiEnvelope, ApiStandardErrors } from '../../common/swagger';
import { ParseObjectIdPipe } from '../../common/utils';
import { eachNight, formatDateOnly, toDateOnly } from '../../database/common/dates';
import { ReservationStatus } from '../../database/enums';
import { DomainValidationError } from '../../database/errors';
import { Models, getModels } from '../../database/models';

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
  private readonly m: Models;

  constructor(@InjectConnection() connection: Connection) {
    this.m = getModels(connection);
  }

  private range(q: DateRangeQueryDto) {
    const from = toDateOnly(q.from);
    const to = toDateOnly(q.to);
    const n = eachNight(from, to).length;
    if (n < 1 || n > 366) throw new DomainValidationError('Range must be 1..366 days');
    return { from, to };
  }

  async occupancy(propertyId: Types.ObjectId, q: DateRangeQueryDto) {
    const { from, to } = this.range(q);
    const rows = await this.m.Inventory.aggregate<{ _id: Date; total: number; sold: number; blocked: number }>([
      { $match: { propertyId, date: { $gte: from, $lt: to } } },
      { $group: { _id: '$date', total: { $sum: '$total' }, sold: { $sum: '$sold' }, blocked: { $sum: '$blocked' } } },
      { $sort: { _id: 1 } },
    ]);
    return rows.map((r) => ({
      date: formatDateOnly(r._id),
      total: r.total,
      sold: r.sold,
      blocked: r.blocked,
      occupancyPct: r.total > r.blocked ? Math.round((r.sold / (r.total - r.blocked)) * 1000) / 10 : 0,
    }));
  }

  /** Revenue of stays arriving in [from, to), by source, excluding cancellations. */
  async revenue(propertyId: Types.ObjectId, q: DateRangeQueryDto) {
    const { from, to } = this.range(q);
    const [property, bySource, capacity] = await Promise.all([
      this.m.Property.findById(propertyId, { currency: 1 }).lean(),
      this.m.Reservation.aggregate<{ _id: string; bookings: number; revenue: number; roomNights: number }>([
        { $match: { propertyId, checkIn: { $gte: from, $lt: to }, status: { $nin: [ReservationStatus.CANCELLED] } } },
        {
          $group: {
            _id: '$source',
            bookings: { $sum: 1 },
            revenue: { $sum: { $subtract: ['$subtotal', '$discount'] } },
            roomNights: { $sum: { $multiply: ['$nights', { $sum: '$reservationRooms.quantity' }] } },
          },
        },
        { $sort: { revenue: -1 } },
      ]),
      this.m.Inventory.aggregate<{ n: number }>([{ $match: { propertyId, date: { $gte: from, $lt: to } } }, { $group: { _id: null, n: { $sum: '$total' } } }]),
    ]);
    const totalRevenue = bySource.reduce((a, r) => a + r.revenue, 0);
    const availableRoomNights = capacity[0]?.n ?? 0;
    return {
      currency: property?.currency,
      bySource: bySource.map((r) => ({ source: r._id, bookings: r.bookings, roomNights: r.roomNights, revenue: r.revenue, adr: r.roomNights ? Math.round(r.revenue / r.roomNights) : 0 })),
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
  occupancy(@Param('propertyId', ParseObjectIdPipe) propertyId: Types.ObjectId, @Query() q: DateRangeQueryDto) {
    return this.reports.occupancy(propertyId, q);
  }

  @Get('revenue')
  @PropertyAccess(Permission.REPORTS_VIEW, { in: 'param', key: 'propertyId', entity: 'property' })
  @ApiOperation({ summary: 'Room revenue by source with ADR and RevPAR (net of discounts, excluding tax)' })
  @ApiEnvelope(RevenueReportDto)
  @ApiStandardErrors({ notFound: true })
  revenue(@Param('propertyId', ParseObjectIdPipe) propertyId: Types.ObjectId, @Query() q: DateRangeQueryDto) {
    return this.reports.revenue(propertyId, q);
  }
}

@Module({ controllers: [ReportsController], providers: [ReportsService] })
export class ReportsModule {}
