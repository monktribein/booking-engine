import { Body, Controller, Get, Headers, Injectable, Module, Param, Post, Query } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection } from '@nestjs/mongoose';
import { ApiHeader, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEmail,
  IsIn,
  IsInt,
  IsMongoId,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { Connection, Types } from 'mongoose';
import type { RequestMeta } from '../../common/auth/auth-user';
import { Public, ReqMeta } from '../../common/decorators';
import { IsDateOnly } from '../../common/dto';
import { ApiEnvelope, ApiStandardErrors } from '../../common/swagger';
import { toObjectId } from '../../common/utils';
import type { AppConfig } from '../../config/configuration';
import { toDateOnly } from '../../database/common/dates';
import { percentOf } from '../../database/common/money';
import { PaymentProvider, PaymentStatus, PropertyStatus, RatePlanStatus, ReservationSource, ReservationStatus, RoomTypeStatus } from '../../database/enums';
import { DomainValidationError, NotFoundError } from '../../database/errors';
import { Models, getModels } from '../../database/models';
import type { Reservation } from '../../database/schemas/reservation.schema';
import { AvailabilityService } from '../../database/services/availability.service';
import { ReservationService } from '../../database/services/reservation.service';
import { OutboxDispatcher } from '../../jobs/outbox.dispatcher';
import { AvailabilityQueryDto, AvailabilityResultDto } from '../inventory/inventory.dto';
import { CheckoutDto, PaymentsModule } from '../payments/payments.module';
import { PaymentsService } from '../payments/payments.service';
import { PricingService } from '../rates/pricing.service';
import { RatesModule } from '../rates/rates.module';

// ------------------------------------------------------------------ DTOs

export class PublicAvailabilityQueryDto extends AvailabilityQueryDto {
  @ApiPropertyOptional({ example: 'DIWALI10' }) @IsOptional() @Matches(/^[A-Za-z0-9_-]{3,30}$/) promoCode?: string;
}

class PublicGuestDto {
  @ApiProperty() @IsString() @Length(1, 100) firstName!: string;
  @ApiProperty() @IsString() @Length(1, 100) lastName!: string;
  @ApiProperty() @IsEmail() email!: string;
  @ApiProperty({ example: '+919811111111' }) @Matches(/^\+[1-9]\d{6,14}$/, { message: 'phone must be E.164' }) phone!: string;
  @ApiPropertyOptional({ example: 'IN' }) @IsOptional() @Matches(/^[A-Z]{2}$/) country?: string;
}

class PublicRoomDto {
  @ApiProperty() @IsMongoId() roomTypeId!: string;
  @ApiProperty() @IsMongoId() ratePlanId!: string;
  @ApiProperty({ example: 1 }) @IsInt() @Min(1) @Max(10) quantity!: number;
}

export class PublicReservationDto {
  @ApiProperty({ example: 'radha-ashram' }) @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/) propertySlug!: string;
  @ApiProperty({ example: '2026-10-05' }) @IsDateOnly() checkIn!: string;
  @ApiProperty({ example: '2026-10-07' }) @IsDateOnly() checkOut!: string;
  @ApiProperty({ example: 2 }) @IsInt() @Min(1) @Max(50) adults!: number;
  @ApiPropertyOptional({ example: 0 }) @IsOptional() @IsInt() @Min(0) @Max(50) children?: number;
  @ApiProperty({ type: [PublicRoomDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => PublicRoomDto)
  rooms!: PublicRoomDto[];
  @ApiProperty({ type: PublicGuestDto }) @ValidateNested() @Type(() => PublicGuestDto) guest!: PublicGuestDto;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(0, 1000) specialRequests?: string;
  @ApiPropertyOptional() @IsOptional() @Matches(/^[A-Za-z0-9_-]{3,30}$/) promoCode?: string;
  @ApiPropertyOptional({ enum: ['DIRECT', 'TIRVONA'], default: 'DIRECT', description: 'Property website or the Tirvona marketplace' })
  @IsOptional()
  @IsIn(['DIRECT', 'TIRVONA'])
  source?: 'DIRECT' | 'TIRVONA';
}

class PublicRoomTypeDto {
  @ApiProperty() _id!: string;
  @ApiProperty() name!: string;
  @ApiPropertyOptional() description?: string;
  @ApiProperty() maxOccupancy!: number;
  @ApiProperty({ type: [String] }) amenities!: string[];
  @ApiProperty({ type: [Object] }) images!: Record<string, unknown>[];
  @ApiProperty({ description: 'Lowest active rate plan price per night' }) fromPrice!: number;
}

export class PublicPropertyDto {
  @ApiProperty() slug!: string;
  @ApiProperty() name!: string;
  @ApiPropertyOptional() description?: string;
  @ApiProperty() city!: string;
  @ApiProperty() state!: string;
  @ApiProperty() country!: string;
  @ApiProperty() address!: string;
  @ApiPropertyOptional() latitude?: number;
  @ApiPropertyOptional() longitude?: number;
  @ApiProperty() currency!: string;
  @ApiProperty() timezone!: string;
  @ApiProperty() checkInTime!: string;
  @ApiProperty() checkOutTime!: string;
  @ApiProperty() taxPercent!: number;
  @ApiProperty({ type: [String] }) amenities!: string[];
  @ApiProperty({ type: [Object] }) images!: Record<string, unknown>[];
  @ApiProperty({ type: [PublicRoomTypeDto] }) roomTypes!: PublicRoomTypeDto[];
}

export class PublicReservationViewDto {
  @ApiProperty() reservationCode!: string;
  @ApiProperty() status!: string;
  @ApiProperty() propertyName!: string;
  @ApiProperty() checkIn!: string;
  @ApiProperty() checkOut!: string;
  @ApiProperty() nights!: number;
  @ApiProperty() adults!: number;
  @ApiProperty() children!: number;
  @ApiProperty({ type: [Object] }) rooms!: Record<string, unknown>[];
  @ApiProperty() subtotal!: number;
  @ApiProperty() tax!: number;
  @ApiProperty() discount!: number;
  @ApiProperty() total!: number;
  @ApiProperty() currency!: string;
  @ApiProperty() paymentStatus!: string;
  @ApiPropertyOptional({ nullable: true }) holdExpiresAt!: string | null;
}

export class PublicBookingResultDto {
  @ApiProperty({ type: PublicReservationViewDto }) reservation!: PublicReservationViewDto;
  @ApiPropertyOptional({ type: CheckoutDto, nullable: true, description: 'Open Razorpay Checkout with this, then POST /payments/verify' })
  payment!: CheckoutDto | null;
  @ApiProperty({ description: 'False when this was an idempotent replay of an earlier request' }) created!: boolean;
}

/** How a booking was made when it is not the public website: the public API passes its tenant and source. */
export interface BookingContext {
  /** The property must belong to this organization (tenant isolation); otherwise it is reported as not found. */
  organizationId?: Types.ObjectId;
  source?: ReservationSource;
  channel?: string;
}

// ------------------------------------------------------------------ service

/**
 * The guest-facing booking engine (property website and Tirvona marketplace).
 * It shares inventory, pricing and the reservation transaction with the PMS,
 * so there is exactly one path by which a room can be sold.
 */
@Injectable()
export class BookingEngineService {
  private readonly m: Models;

  constructor(
    @InjectConnection() connection: Connection,
    private readonly availability: AvailabilityService,
    private readonly reservations: ReservationService,
    private readonly pricing: PricingService,
    private readonly payments: PaymentsService,
    private readonly outbox: OutboxDispatcher,
    private readonly config: ConfigService<AppConfig, true>,
  ) {
    this.m = getModels(connection);
  }

  private async propertyBySlug(slug: string, organizationId?: Types.ObjectId) {
    const p = await this.m.Property.findOne({ slug, status: PropertyStatus.ACTIVE, ...(organizationId ? { organizationId } : {}) }).lean();
    if (!p) throw new NotFoundError('Property', slug);
    return p;
  }

  async property(slug: string, organizationId?: Types.ObjectId) {
    const p = await this.propertyBySlug(slug, organizationId);
    const [roomTypes, ratePlans] = await Promise.all([
      this.m.RoomType.find({ propertyId: p._id, status: RoomTypeStatus.ACTIVE, totalRooms: { $gt: 0 } }).sort({ sortOrder: 1 }).lean(),
      this.m.RatePlan.find({ propertyId: p._id, status: RatePlanStatus.ACTIVE }, { roomTypeId: 1, basePrice: 1 }).lean(),
    ]);
    return {
      slug: p.slug,
      name: p.name,
      description: p.description,
      address: p.address,
      city: p.city,
      state: p.state,
      country: p.country,
      latitude: p.latitude,
      longitude: p.longitude,
      currency: p.currency,
      timezone: p.timezone,
      checkInTime: p.checkInTime,
      checkOutTime: p.checkOutTime,
      taxPercent: p.taxPercent,
      amenities: p.amenities,
      images: p.images,
      roomTypes: roomTypes.map((rt) => ({
        _id: rt._id,
        name: rt.name,
        description: rt.description,
        maxOccupancy: rt.maxOccupancy,
        amenities: rt.amenities,
        images: rt.images,
        fromPrice: Math.min(...ratePlans.filter((r) => r.roomTypeId.equals(rt._id)).map((r) => r.basePrice), rt.basePrice),
      })),
    };
  }

  /** Room availability + rate + tax + discount + restriction reasons for a stay. */
  async search(slug: string, q: PublicAvailabilityQueryDto, organizationId?: Types.ObjectId) {
    const p = await this.propertyBySlug(slug, organizationId);
    const results = await this.availability.search({ propertyId: p._id, checkIn: q.checkIn, checkOut: q.checkOut, adults: q.adults, children: q.children, rooms: q.rooms });
    if (!q.promoCode) return results;
    const promo = await this.pricing.resolvePromotion(p._id, q.promoCode, toDateOnly(q.checkIn), toDateOnly(q.checkOut));
    return results.map((rt) => ({
      ...rt,
      ratePlans: rt.ratePlans.map((rp) => {
        const discount = PricingService.discountFor(promo, [{ roomTypeId: rt.roomTypeId, total: rp.total }]);
        return { ...rp, discount, total: rp.total - discount };
      }),
    }));
  }

  async book(dto: PublicReservationDto, idempotencyKey: string | undefined, meta: RequestMeta, ctx: BookingContext = {}) {
    const p = await this.propertyBySlug(dto.propertySlug, ctx.organizationId);
    const checkIn = toDateOnly(dto.checkIn);
    const checkOut = toDateOnly(dto.checkOut);
    const rooms = dto.rooms.map((r) => ({
      roomTypeId: toObjectId(r.roomTypeId, 'roomTypeId'),
      ratePlanId: toObjectId(r.ratePlanId, 'ratePlanId'),
      quantity: r.quantity,
    }));

    let discount = 0;
    if (dto.promoCode) {
      const promo = await this.pricing.resolvePromotion(p._id, dto.promoCode, checkIn, checkOut);
      // Discount on the server-computed price, never on anything the client sends.
      const plans = await this.m.RatePlan.find({ _id: { $in: rooms.map((r) => r.ratePlanId) }, propertyId: p._id }, { basePrice: 1 }).lean();
      const price = new Map(plans.map((x) => [String(x._id), x.basePrice]));
      const nights = Math.round((checkOut.getTime() - checkIn.getTime()) / 86_400_000);
      const lines = rooms.map((r) => {
        const sub = (price.get(String(r.ratePlanId)) ?? 0) * nights * r.quantity;
        return { roomTypeId: r.roomTypeId, total: sub + percentOf(sub, p.taxPercent) };
      });
      discount = PricingService.discountFor(promo, lines);
    }

    const requirePayment = this.config.get('bookingEngine', { infer: true }).requirePayment;
    if (requirePayment && !this.payments.gateway(PaymentProvider.RAZORPAY).isConfigured()) {
      throw new DomainValidationError('Online booking is temporarily unavailable (payments not configured)');
    }
    const { reservation, created } = await this.reservations.createReservation({
      propertyId: p._id,
      source: ctx.source ?? (dto.source === 'TIRVONA' ? ReservationSource.TIRVONA : ReservationSource.DIRECT),
      idempotencyKey,
      // With online payment the booking is a PENDING hold until the payment is captured.
      status: requirePayment ? ReservationStatus.PENDING : ReservationStatus.CONFIRMED,
      guest: dto.guest,
      checkIn,
      checkOut,
      adults: dto.adults,
      children: dto.children,
      rooms,
      discount,
      specialRequests: dto.specialRequests,
      auditMetadata: { channel: ctx.channel ?? 'booking-engine', promoCode: dto.promoCode, ip: meta.ip },
    });
    void this.outbox.flush();

    let payment = null;
    if (requirePayment && reservation.status === ReservationStatus.PENDING && reservation.total > 0) {
      // Idempotent replay: reuse the order created by the first request.
      const existing = await this.m.Payment.findOne({ reservationId: reservation._id, status: PaymentStatus.PENDING }).lean();
      payment = existing?.providerOrderId
        ? {
            provider: existing.provider,
            keyId: this.payments.gateway(existing.provider).publicKey(),
            orderId: existing.providerOrderId,
            amount: existing.amount,
            currency: existing.currency,
            reservationCode: reservation.reservationCode,
            prefill: { name: `${reservation.guest.firstName} ${reservation.guest.lastName}`, email: reservation.guest.email, contact: reservation.guest.phone },
          }
        : (await this.payments.createGatewayOrder(null, meta, reservation, this.payments.balanceDue(reservation))).checkout;
    }
    return { reservation: this.publicView(reservation, p.name), payment, created };
  }

  /** Guests look up their booking with the code plus the email used to book. */
  async lookup(code: string, email: string) {
    const r = await this.m.Reservation.findOne({ reservationCode: code.toUpperCase() }).lean();
    if (!r || !r.guest.email || r.guest.email !== email.trim().toLowerCase()) throw new NotFoundError('Reservation', code);
    const p = await this.m.Property.findById(r.propertyId, { name: 1 }).lean();
    return this.publicView(r, p?.name ?? '');
  }

  private publicView(r: Reservation, propertyName: string) {
    return {
      reservationCode: r.reservationCode,
      status: r.status,
      propertyName,
      checkIn: r.checkIn,
      checkOut: r.checkOut,
      nights: r.nights,
      adults: r.adults,
      children: r.children,
      rooms: r.reservationRooms.map((l) => ({ roomTypeName: l.roomTypeName, ratePlan: l.ratePlan?.name, mealPlan: l.ratePlan?.mealPlan, cancellationPolicy: l.ratePlan?.cancellationPolicy, total: l.total })),
      subtotal: r.subtotal,
      tax: r.tax,
      discount: r.discount,
      total: r.total,
      currency: r.currency,
      paymentStatus: r.paymentStatus,
      holdExpiresAt: r.holdExpiresAt,
    };
  }
}

// ------------------------------------------------------------------ controller

@ApiTags('Booking engine (public)')
@Public()
@Throttle({ default: { limit: 60, ttl: 60_000 } })
@Controller('public')
export class BookingEngineController {
  constructor(private readonly engine: BookingEngineService) {}

  @Get('properties/:slug')
  @ApiOperation({ summary: 'Public property page data: details, room types, from-prices' })
  @ApiEnvelope(PublicPropertyDto)
  @ApiStandardErrors({ auth: false, notFound: true })
  property(@Param('slug') slug: string) {
    return this.engine.property(slug);
  }

  @Get('properties/:slug/availability')
  @ApiOperation({ summary: 'Availability with rate, tax, discount (promo), min/max stay, CTA/CTD and stop-sell checks' })
  @ApiEnvelope(AvailabilityResultDto, { isArray: true })
  @ApiStandardErrors({ auth: false, notFound: true })
  availability(@Param('slug') slug: string, @Query() q: PublicAvailabilityQueryDto) {
    return this.engine.search(slug, q);
  }

  @Post('reservations')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Book as a guest. Creates a PENDING hold (inventory reserved atomically) plus a Razorpay order; the hold is confirmed when payment is captured or released when it expires.',
  })
  @ApiHeader({ name: 'Idempotency-Key', required: false, description: 'Retrying with the same key never books twice' })
  @ApiEnvelope(PublicBookingResultDto, { status: 201 })
  @ApiStandardErrors({ auth: false, notFound: true, conflict: 'ROOM_NOT_AVAILABLE / RESTRICTION_VIOLATION' })
  book(@Body() dto: PublicReservationDto, @ReqMeta() meta: RequestMeta, @Headers('idempotency-key') idempotencyKey?: string) {
    if (idempotencyKey && !/^[A-Za-z0-9_-]{8,100}$/.test(idempotencyKey)) {
      throw new DomainValidationError('Idempotency-Key must be 8-100 characters of [A-Za-z0-9_-]');
    }
    return this.engine.book(dto, idempotencyKey, meta);
  }

  @Get('reservations/:code')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Guest booking lookup (code + booking email)' })
  @ApiEnvelope(PublicReservationViewDto)
  @ApiStandardErrors({ auth: false, notFound: true })
  lookup(@Param('code') code: string, @Query('email') email: string) {
    if (!email) throw new DomainValidationError('email is required');
    return this.engine.lookup(code, email);
  }
}

@Module({
  imports: [RatesModule, PaymentsModule],
  controllers: [BookingEngineController],
  providers: [BookingEngineService],
  exports: [BookingEngineService],
})
export class BookingEngineModule {}

