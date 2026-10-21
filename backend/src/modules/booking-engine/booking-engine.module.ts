import { Body, Controller, Get, Headers, HttpCode, Injectable, Module, Param, Post, Query } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
  IsUUID,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import type { RequestMeta } from '../../common/auth/auth-user';
import { Public, ReqMeta } from '../../common/decorators';
import { IsDateOnly } from '../../common/dto';
import { PARTNER_OPERABLE, PUBLICLY_BOOKABLE } from '../../common/public-visibility';
import { ApiEnvelope, ApiStandardErrors } from '../../common/swagger';
import { toUuid } from '../../common/utils';
import type { AppConfig } from '../../config/configuration';
import { formatDateOnly, todayIn, toDateOnly } from '../../database/common/dates';
import { percentOf } from '../../database/common/money';
import { PaymentProvider, PaymentStatus, PropertyStatus, RatePlanStatus, ReservationSource, ReservationStatus, RoomTypeStatus, MarketplaceStatus } from '../../database/enums';
import { DomainError, DomainValidationError, NotFoundError } from '../../database/errors';
import { Db, InjectDb } from '../../database/kysely';
import { Reservation, findReservation } from '../../database/reservation-store';
import { AvailabilityService } from '../../database/services/availability.service';
import { ReservationService } from '../../database/services/reservation.service';
import { OutboxDispatcher } from '../../jobs/outbox.dispatcher';
import { AvailabilityQueryDto, AvailabilityResultDto } from '../inventory/inventory.dto';
import { CheckoutDto, PaymentsModule } from '../payments/payments.module';
import { PaymentsService } from '../payments/payments.service';
import { PricingService } from '../rates/pricing.service';
import { RatesModule } from '../rates/rates.module';
import { PropertySearchQueryDto, PropertySearchResultDto, PropertySearchService } from './property-search';

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
  @ApiProperty() @IsUUID() roomTypeId!: string;
  @ApiProperty() @IsUUID() ratePlanId!: string;
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
  @ApiPropertyOptional({ example: 735000, description: 'The total (minor units, after any discount) the guest was shown. If the server now calculates a different total the booking is refused with PRICE_CHANGED and nothing is held.' })
  @IsOptional()
  @IsInt()
  @Min(0)
  expectedTotal?: number;
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

export class GuestCancellationDto {
  @ApiProperty({ description: 'Whether the guest can cancel this booking online right now' }) allowed!: boolean;
  @ApiPropertyOptional({ nullable: true, description: 'Why not, when allowed is false' }) reason!: string | null;
  @ApiProperty({ description: 'Minor units refunded if cancelled now, under the cancellation policy of the rate that was booked' }) refundIfCancelledNow!: number;
}

export class GuestCancelDto {
  @ApiProperty({ example: 'emma@example.com', description: 'The e-mail the booking was made with' }) @IsEmail() email!: string;
}

export class PublicReservationViewDto {
  @ApiPropertyOptional({ type: GuestCancellationDto, description: 'Present on lookups' }) cancellation?: GuestCancellationDto;
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
  organizationId?: string;
  source?: ReservationSource;
  channel?: string;
  /** Public API: which key made the booking, and the partner software's own reference for it. */
  apiKeyId?: string;
  partnerReference?: string;
}

// ------------------------------------------------------------------ service

/**
 * The guest-facing booking engine (property website and Tirvona marketplace). It shares inventory, pricing and the
 * reservation transaction with the PMS, so there is exactly one path by which a room can be sold.
 */
@Injectable()
export class BookingEngineService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly availability: AvailabilityService,
    private readonly reservations: ReservationService,
    private readonly pricing: PricingService,
    private readonly payments: PaymentsService,
    private readonly outbox: OutboxDispatcher,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  private async propertyBySlug(slug: string, organizationId?: string) {
    // Public visitors only reach what the owner published and the platform allows; a partner's own API key reaches its own
    // properties whenever the organization is approved and the property is active.
    let q = this.db.selectFrom('properties').selectAll().where('slug', '=', slug).where(organizationId ? PARTNER_OPERABLE : PUBLICLY_BOOKABLE);
    if (organizationId) q = q.where('organizationId', '=', organizationId);
    const p = await q.executeTakeFirst();
    if (!p) throw new NotFoundError('Property', slug);
    return p;
  }

  async property(slug: string, organizationId?: string) {
    const p = await this.propertyBySlug(slug, organizationId);
    const [roomTypes, ratePlans] = await Promise.all([
      this.db.selectFrom('roomTypes').selectAll().where('propertyId', '=', p.id).where('status', '=', RoomTypeStatus.ACTIVE).where('totalRooms', '>', 0).orderBy('sortOrder').orderBy('name').execute(),
      this.db.selectFrom('ratePlans').select(['roomTypeId', 'basePrice']).where('propertyId', '=', p.id).where('status', '=', RatePlanStatus.ACTIVE).execute(),
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
        // The public contract names the room type id `_id` (the v1 API passes this object through unchanged).
        _id: rt.id,
        name: rt.name,
        description: rt.description,
        maxOccupancy: rt.maxOccupancy,
        amenities: rt.amenities,
        images: rt.images,
        fromPrice: Math.min(...ratePlans.filter((r) => r.roomTypeId === rt.id).map((r) => r.basePrice), rt.basePrice),
      })),
    };
  }

  /** Room availability + rate + tax + discount + restriction reasons for a stay. */
  async search(slug: string, q: PublicAvailabilityQueryDto, organizationId?: string) {
    const p = await this.propertyBySlug(slug, organizationId);
    const results = await this.availability.search({ propertyId: p.id, checkIn: q.checkIn, checkOut: q.checkOut, adults: q.adults, children: q.children, rooms: q.rooms });
    if (!q.promoCode) return results;
    const promo = await this.pricing.resolvePromotion(p.id, q.promoCode, toDateOnly(q.checkIn), toDateOnly(q.checkOut));
    return results.map((rt) => ({
      ...rt,
      ratePlans: rt.ratePlans.map((rp) => {
        const line = [{ roomTypeId: rt.roomTypeId, total: rp.total }];
        const promoProblem = PricingService.minimumValueProblem(promo, line);
        if (promoProblem) return { ...rp, discount: 0, promoProblem };
        const discount = PricingService.discountFor(promo, line);
        return { ...rp, discount, total: rp.total - discount };
      }),
    }));
  }

  async book(dto: PublicReservationDto, idempotencyKey: string | undefined, meta: RequestMeta, ctx: BookingContext = {}) {
    const p = await this.propertyBySlug(dto.propertySlug, ctx.organizationId);
    const checkIn = toDateOnly(dto.checkIn);
    const checkOut = toDateOnly(dto.checkOut);
    const rooms = dto.rooms.map((r) => ({
      roomTypeId: toUuid(r.roomTypeId, 'roomTypeId'),
      ratePlanId: toUuid(r.ratePlanId, 'ratePlanId'),
      quantity: r.quantity,
    }));

    const requirePayment = this.config.get('bookingEngine', { infer: true }).requirePayment;
    if (requirePayment && !this.payments.gateway(PaymentProvider.RAZORPAY).isConfigured()) {
      throw new DomainValidationError('Online booking is temporarily unavailable (payments not configured)');
    }
    const { reservation, created } = await this.reservations.createReservation({
      propertyId: p.id,
      // A booking counts as a Tirvona marketplace booking only for a property that is actually approved there; everything else
      // that comes through the public website is a direct booking.
      source: ctx.source ?? (dto.source === 'TIRVONA' && p.marketplaceStatus === MarketplaceStatus.APPROVED ? ReservationSource.TIRVONA : ReservationSource.DIRECT),
      idempotencyKey,
      apiKeyId: ctx.apiKeyId ?? null,
      partnerReference: ctx.partnerReference,
      // With online payment the booking is a PENDING hold until the payment is captured.
      status: requirePayment ? ReservationStatus.PENDING : ReservationStatus.CONFIRMED,
      guest: dto.guest,
      checkIn,
      checkOut,
      adults: dto.adults,
      children: dto.children,
      rooms,
      // Priced, limited and recorded inside the booking transaction; nothing the client sends decides the price.
      promotionCode: dto.promoCode,
      expectedTotal: dto.expectedTotal,
      specialRequests: dto.specialRequests,
      auditMetadata: { channel: ctx.channel ?? 'booking-engine', promoCode: dto.promoCode, ip: meta.ip, ...(ctx.apiKeyId ? { apiKeyId: ctx.apiKeyId } : {}) },
    });
    void this.outbox.flush();

    let payment = null;
    if (requirePayment && reservation.status === ReservationStatus.PENDING && reservation.total > 0) {
      // Idempotent replay: reuse the order created by the first request.
      const existing = await this.db.selectFrom('payments').selectAll().where('reservationId', '=', reservation.id).where('status', '=', PaymentStatus.PENDING).orderBy('createdAt').limit(1).executeTakeFirst();
      payment = existing?.providerOrderId
        ? {
            provider: existing.provider,
            keyId: this.payments.gateway(existing.provider as PaymentProvider).publicKey(),
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
    const { r, p } = await this.ownBooking(code, email);
    return { ...this.publicView(r, p.name), cancellation: this.cancellationOf(r, p) };
  }

  /**
   * Guests cancel online only bookings made on the public site (DIRECT or marketplace): partner software cancels its own through the
   * API and a channel cancels its own. Allowed while the booking is PENDING or CONFIRMED and the stay has not started. The refund
   * follows the cancellation policy that was frozen on the booking, exactly as for a cancellation by staff.
   */
  async cancel(code: string, email: string, meta: RequestMeta) {
    const { r, p } = await this.ownBooking(code, email);
    const verdict = this.cancellationOf(r, p);
    if (!verdict.allowed && r.status !== ReservationStatus.CANCELLED) throw new DomainError('CANCELLATION_NOT_ALLOWED', verdict.reason ?? 'This booking cannot be cancelled online.');
    const res = await this.reservations.cancelReservation({ propertyId: r.propertyId, reservationId: r.id, reason: 'Cancelled by the guest', cancelledBy: null });
    void this.outbox.flush();
    void meta;
    const after = { ...res.reservation };
    return {
      reservation: { ...this.publicView(after, p.name), cancellation: { allowed: false, reason: 'This booking is cancelled.', refundIfCancelledNow: 0 } },
      alreadyCancelled: res.alreadyCancelled,
      refunds: res.refunds.map((x) => ({ amount: x.amount, currency: x.currency, status: x.status })),
    };
  }

  /** The booking for this code, only if the e-mail matches (the same 404 as an unknown code: nothing is revealed). */
  private async ownBooking(code: string, email: string) {
    const r = await findReservation(this.db, { reservationCode: code });
    if (!r || !r.guest.email || r.guest.email !== email.trim().toLowerCase()) throw new NotFoundError('Reservation', code);
    const p = await this.db.selectFrom('properties').select(['name', 'checkInTime', 'timezone']).where('id', '=', r.propertyId).executeTakeFirstOrThrow();
    return { r, p };
  }

  private cancellationOf(r: Reservation, p: { checkInTime: string; timezone: string }) {
    const fromPublicSite = r.source === ReservationSource.DIRECT || r.source === ReservationSource.TIRVONA;
    const open = r.status === ReservationStatus.PENDING || r.status === ReservationStatus.CONFIRMED;
    const started = r.checkIn.getTime() < toDateOnly(formatDateOnly(todayIn(p.timezone))).getTime();
    let reason: string | null = null;
    if (!fromPublicSite) reason = 'This booking was not made on this site. Contact the property or the platform where you booked.';
    else if (!open) reason = r.status === ReservationStatus.CANCELLED ? 'This booking is already cancelled.' : 'This booking can no longer be cancelled online.';
    else if (started) reason = 'The stay has already started. Contact the property.';
    return { allowed: reason === null, reason, refundIfCancelledNow: open && fromPublicSite && !started ? this.reservations.policyRefund(r, p, new Date()) : 0 };
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
  constructor(
    private readonly engine: BookingEngineService,
    private readonly propertySearch: PropertySearchService,
  ) {}

  @Get('properties')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Search bookable properties (destination, dates, guests, price, amenities)',
    description: 'With checkIn + checkOut only properties that can host the stay are returned, priced for it. Looks at up to 100 matching properties per request.',
  })
  @ApiEnvelope(PropertySearchResultDto)
  @ApiStandardErrors({ auth: false })
  searchProperties(@Query() q: PropertySearchQueryDto) {
    return this.propertySearch.search(q);
  }

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

  @Post('reservations/:code/cancel')
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Guest cancels their own booking (code + booking email)',
    description: 'Only bookings made on the public site, while PENDING or CONFIRMED and before the stay starts. The refund follows the cancellation policy of the rate that was booked.',
  })
  @ApiStandardErrors({ auth: false, notFound: true, conflict: 'CANCELLATION_NOT_ALLOWED' })
  cancel(@Param('code') code: string, @Body() dto: GuestCancelDto, @ReqMeta() meta: RequestMeta) {
    return this.engine.cancel(code, dto.email, meta);
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
  providers: [BookingEngineService, PropertySearchService],
  exports: [BookingEngineService],
})
export class BookingEngineModule {}

