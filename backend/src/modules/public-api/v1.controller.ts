import { Body, Controller, Get, Headers, HttpCode, Param, Patch, Post, Put, Query, Res, UseGuards } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiOkResponse, ApiProperty, ApiPropertyOptional, ApiSecurity, ApiTags, OmitType } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsEmail, IsEnum, IsInt, IsOptional, IsString, IsUUID, Length, Matches, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import type { Response } from 'express';
import type { RequestMeta } from '../../common/auth/auth-user';
import { Public, ReqMeta } from '../../common/decorators';
import { IsDateOnly } from '../../common/dto';
import { ApiEnvelope, ApiStandardErrors } from '../../common/swagger';
import { ReservationStatus } from '../../database/enums';
import { DomainError, DomainValidationError } from '../../database/errors';
import { AvailabilityResultDto } from '../inventory/inventory.dto';
import { PublicAvailabilityQueryDto, PublicPropertyDto, PublicReservationDto } from '../booking-engine/booking-engine.module';
import { SetRestrictionsDto } from '../inventory/inventory.dto';
import { CheckoutDto } from '../payments/payments.module';
import { UpdateReservationDto } from '../reservations/reservations.dto';
import type { UpdateReservationInput } from './v1.service';
import { ApiKeyGuard, CurrentApiKey, RequireScopes } from './api-key.guard';
import type { ApiPrincipal } from './api-key.service';
import { PublicApiV1Service } from './v1.service';

// ------------------------------------------------------------------ DTOs (the versioned contract)

/** Same as the public website's booking request, minus `source`: API bookings are always source API. */
export class CreateReservationV1Dto extends OmitType(PublicReservationDto, ['source'] as const) {
  @ApiPropertyOptional({
    example: 'PMS-48213',
    description:
      'Your own id for this booking, unique per property. Sending the same reference again returns the original booking (HTTP 200); the same reference with different content is rejected with 422 EXTERNAL_REFERENCE_REUSED. It is also returned on reads, in webhooks, and can be used to filter the reservation list.',
  })
  @IsOptional()
  @Matches(/^[A-Za-z0-9._:/-]{1,100}$/, { message: 'externalReference must be 1-100 characters of [A-Za-z0-9._:/-]' })
  externalReference?: string;
}

export class UpdateGuestV1Dto {
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 100) firstName?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(0, 100) lastName?: string;
  @ApiPropertyOptional() @IsOptional() @IsEmail() email?: string;
  @ApiPropertyOptional({ example: '+919811111111' }) @IsOptional() @Matches(/^\+[1-9]\d{6,14}$/) phone?: string;
}

/** Everything is optional: send only what changes. */
export class UpdateReservationV1Dto extends OmitType(UpdateReservationDto, ['guest'] as const) {
  @ApiPropertyOptional({ type: UpdateGuestV1Dto, description: 'Only the fields you send are changed' }) @IsOptional() @ValidateNested() @Type(() => UpdateGuestV1Dto) guest?: UpdateGuestV1Dto;
}

export class RateUpdateV1Dto {
  @ApiProperty() @IsUUID() ratePlanId!: string;
  @ApiProperty({ example: 350000, description: 'Nightly base price in minor units (paise)' }) @IsInt() @Min(0) @Max(100_000_000) basePrice!: number;
}

export class UpdateRatesV1Dto {
  @ApiProperty({ type: [RateUpdateV1Dto] }) @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => RateUpdateV1Dto) updates!: RateUpdateV1Dto[];
}

export class InventoryQueryV1Dto {
  @ApiProperty({ example: '2026-10-01' }) @IsDateOnly() from!: string;
  @ApiProperty({ example: '2026-10-15', description: 'Exclusive; at most 366 nights' }) @IsDateOnly() to!: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() roomTypeId?: string;
}

export class ListReservationsV1Query {
  @ApiPropertyOptional({ example: 'radha-ashram' }) @IsOptional() @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/) propertySlug?: string;
  @ApiPropertyOptional({ enum: ReservationStatus }) @IsOptional() @IsEnum(ReservationStatus) status?: ReservationStatus;
  @ApiPropertyOptional({ description: 'Your own reference, as sent when creating the booking' }) @IsOptional() @IsString() @MaxLength(100) externalReference?: string;
  @ApiPropertyOptional({ example: '2026-10-01', description: 'Check-in on or after (YYYY-MM-DD)' }) @IsOptional() @IsDateOnly() checkInFrom?: string;
  @ApiPropertyOptional({ example: '2026-10-31', description: 'Check-in on or before (YYYY-MM-DD)' }) @IsOptional() @IsDateOnly() checkInTo?: string;
  @ApiPropertyOptional({ default: 1, minimum: 1 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 20;
}

export class CancelReservationV1Dto {
  @ApiPropertyOptional({ example: 'Guest changed plans' }) @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

export class PropertySummaryV1Dto {
  @ApiProperty() id!: string;
  @ApiProperty({ example: 'radha-ashram' }) slug!: string;
  @ApiProperty() name!: string;
  @ApiProperty() city!: string;
  @ApiProperty() state!: string;
  @ApiProperty() country!: string;
  @ApiProperty({ example: 'INR' }) currency!: string;
  @ApiProperty({ example: 'Asia/Kolkata' }) timezone!: string;
}

export class GuestV1Dto {
  @ApiProperty() firstName!: string;
  @ApiProperty() lastName!: string;
  @ApiPropertyOptional({ nullable: true }) email!: string | null;
  @ApiPropertyOptional({ nullable: true }) phone!: string | null;
  @ApiProperty({ description: 'true: only first name and last initial are shown because the key lacks the guests:read scope (and did not create this booking)' }) redacted!: boolean;
}

export class ReservationV1Dto {
  @ApiProperty({ example: 'TRV-7K3M9QXD' }) reservationCode!: string;
  @ApiProperty({ enum: ReservationStatus }) status!: string;
  @ApiProperty() propertyId!: string;
  @ApiProperty() propertySlug!: string;
  @ApiProperty() propertyName!: string;
  @ApiProperty({ example: '2026-10-05' }) checkIn!: string;
  @ApiProperty({ example: '2026-10-07' }) checkOut!: string;
  @ApiProperty() nights!: number;
  @ApiProperty() adults!: number;
  @ApiProperty() children!: number;
  @ApiProperty({ type: GuestV1Dto }) guest!: GuestV1Dto;
  @ApiProperty({ type: [Object], description: 'roomTypeId, roomTypeName, ratePlanId, ratePlan, mealPlan, cancellationPolicy, quantity, total' }) rooms!: Record<string, unknown>[];
  @ApiProperty({ description: 'Minor units (paise)' }) subtotal!: number;
  @ApiProperty() tax!: number;
  @ApiProperty() discount!: number;
  @ApiProperty() total!: number;
  @ApiProperty() amountPaid!: number;
  @ApiProperty({ example: 'INR' }) currency!: string;
  @ApiProperty() paymentStatus!: string;
  @ApiProperty({ example: 'API', description: 'Where the booking came from: DIRECT (property site), TIRVONA (marketplace), API (partner software), an OTA code, or a front-desk source' }) source!: string;
  @ApiPropertyOptional({ nullable: true, description: 'Your own reference, when you supplied one' }) externalReference!: string | null;
  @ApiPropertyOptional({ nullable: true }) specialRequests!: string | null;
  @ApiPropertyOptional({ nullable: true, description: 'A PENDING booking releases its rooms at this instant unless paid' }) holdExpiresAt!: string | null;
  @ApiProperty() createdAt!: string;
}

export class CreateReservationV1ResultDto {
  @ApiProperty({ type: ReservationV1Dto }) reservation!: ReservationV1Dto;
  @ApiPropertyOptional({ type: CheckoutDto, nullable: true, description: 'Razorpay Checkout parameters when payment is required; complete payment in the guest\'s browser, then POST /payments/verify' })
  payment!: CheckoutDto | null;
  @ApiProperty({ description: 'false when this was an idempotent replay of an earlier request' }) created!: boolean;
}

export class CancelReservationV1ResultDto {
  @ApiProperty({ type: ReservationV1Dto }) reservation!: ReservationV1Dto;
  @ApiProperty() alreadyCancelled!: boolean;
  @ApiProperty({ type: [Object], description: 'Refunds queued per the rate plan\'s cancellation policy: amount, currency, status' }) refunds!: Record<string, unknown>[];
}

// ------------------------------------------------------------------ controller

/**
 * Public API, version 1. Authenticated with an API key (never a user session); tenant-isolated to the key's
 * organization. Contract rules (docs/PUBLIC_API.md): within v1, fields may be added but never removed or
 * renamed; breaking changes ship as /v2 with an announced sunset for v1.
 */
export class ConnectionStatusDto {
  @ApiProperty({ example: 'ACME_STAY', description: 'Provider code' }) channel!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: ['REST_JSON', 'ICAL', 'CODE'] }) protocol!: string;
  @ApiProperty({ enum: ['DISCONNECTED', 'CONNECTING', 'CONNECTED', 'ERROR', 'EXPIRED'] }) status!: string;
  @ApiProperty({ type: [String], description: 'What this connection can do: listings, pushAvailability, pushRates, pullReservations, ...' }) capabilities!: string[];
  @ApiProperty({ nullable: true }) lastSyncAt!: string | null;
  @ApiProperty({ description: 'false when the last synchronisation or poll failed; details are for the property owner, not for API clients' }) healthy!: boolean;
}

@ApiTags('Public API v1')
@ApiSecurity('api-key')
@Public() // bypasses the JWT guard: this controller has its own authentication
@SkipThrottle() // the per-IP limiter is replaced by the per-key limiter inside ApiKeyGuard
@UseGuards(ApiKeyGuard)
@Controller('v1')
export class PublicApiV1Controller {
  constructor(private readonly api: PublicApiV1Service) {}

  @Get('properties')
  @RequireScopes('properties:read')
  @ApiOperation({ summary: 'List the properties this key can access' })
  @ApiEnvelope(PropertySummaryV1Dto, { isArray: true })
  @ApiStandardErrors({ keyAuth: true })
  properties(@CurrentApiKey() key: ApiPrincipal) {
    return this.api.listProperties(key);
  }

  @Get('properties/:slug')
  @RequireScopes('properties:read')
  @ApiOperation({ summary: 'Property details with room types and from-prices' })
  @ApiEnvelope(PublicPropertyDto)
  @ApiStandardErrors({ keyAuth: true, notFound: true })
  property(@CurrentApiKey() key: ApiPrincipal, @Param('slug') slug: string) {
    return this.api.getProperty(key, slug);
  }

  @Get('properties/:slug/connections')
  @RequireScopes('properties:read')
  @ApiOperation({ summary: 'Channel connections of the property: status and what each can do (no credentials, no error details)' })
  @ApiEnvelope(ConnectionStatusDto, { isArray: true })
  @ApiStandardErrors({ keyAuth: true, notFound: true })
  connections(@CurrentApiKey() key: ApiPrincipal, @Param('slug') slug: string) {
    return this.api.listConnections(key, slug);
  }

  @Get('properties/:slug/availability')
  @RequireScopes('availability:read')
  @ApiOperation({ summary: 'Availability and priced rate plans for a stay (tax, promo discount, restrictions applied)' })
  @ApiEnvelope(AvailabilityResultDto, { isArray: true })
  @ApiStandardErrors({ keyAuth: true, notFound: true })
  availability(@CurrentApiKey() key: ApiPrincipal, @Param('slug') slug: string, @Query() q: PublicAvailabilityQueryDto) {
    return this.api.availability(key, slug, q);
  }

  @Post('reservations')
  @RequireScopes('reservations:write')
  @ApiOperation({
    summary: 'Create a reservation',
    description:
      'Reserves inventory atomically. With online payment enabled the booking is a PENDING hold (see `holdExpiresAt`) and `payment` carries the Razorpay Checkout parameters; ' +
      'it is confirmed when payment is captured (you receive `reservation.confirmed`). `Idempotency-Key` is required: retrying with the same key and body returns the original booking ' +
      '(HTTP 200, `created: false`); the same key with a different body is rejected with 422 IDEMPOTENCY_KEY_REUSED.',
  })
  @ApiHeader({ name: 'Idempotency-Key', required: true, description: '8-100 characters of [A-Za-z0-9_-]. Use a fresh UUID per booking attempt.' })
  @ApiEnvelope(CreateReservationV1ResultDto, { status: 201 })
  @ApiOkResponse({ description: 'Idempotent replay of an earlier request', type: CreateReservationV1ResultDto })
  @ApiStandardErrors({ keyAuth: true, notFound: true, conflict: 'ROOM_NOT_AVAILABLE / RESTRICTION_VIOLATION' })
  async create(
    @CurrentApiKey() key: ApiPrincipal,
    @Body() dto: CreateReservationV1Dto,
    @ReqMeta() meta: RequestMeta,
    @Res({ passthrough: true }) res: Response,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    if (!idempotencyKey) throw new DomainError('IDEMPOTENCY_KEY_REQUIRED', 'The Idempotency-Key header is required when creating reservations');
    const out = await this.api.createReservation(key, dto as PublicReservationDto, idempotencyKey, meta);
    if (!out.created) res.status(200);
    return out;
  }

  @Get('reservations')
  @RequireScopes('reservations:read')
  @ApiOperation({ summary: 'List reservations (newest first), optionally filtered' })
  @ApiEnvelope(ReservationV1Dto, { paginated: true })
  @ApiStandardErrors({ keyAuth: true, notFound: true })
  list(@CurrentApiKey() key: ApiPrincipal, @Query() q: ListReservationsV1Query) {
    if (q.checkInFrom && q.checkInTo && q.checkInFrom > q.checkInTo) throw new DomainValidationError('checkInFrom must not be after checkInTo');
    return this.api.listReservations(key, q);
  }

  @Get('reservations/:code')
  @RequireScopes('reservations:read')
  @ApiOperation({ summary: 'Retrieve a reservation by its code' })
  @ApiEnvelope(ReservationV1Dto)
  @ApiStandardErrors({ keyAuth: true, notFound: true })
  get(@CurrentApiKey() key: ApiPrincipal, @Param('code') code: string) {
    return this.api.getReservation(key, code);
  }

  @Post('reservations/:code/cancel')
  @HttpCode(200)
  @RequireScopes('reservations:write')
  @ApiOperation({
    summary: 'Cancel a reservation',
    description: 'Releases the rooms and queues the refund the rate plan\'s cancellation policy allows. Cancelling an already cancelled reservation succeeds with `alreadyCancelled: true`.',
  })
  @ApiEnvelope(CancelReservationV1ResultDto)
  @ApiStandardErrors({ keyAuth: true, notFound: true, conflict: 'INVALID_STATE_TRANSITION' })
  cancel(@CurrentApiKey() key: ApiPrincipal, @Param('code') code: string, @Body() dto: CancelReservationV1Dto, @ReqMeta() meta: RequestMeta) {
    return this.api.cancelReservation(key, code, dto.reason, meta);
  }

  @Patch('reservations/:code')
  @RequireScopes('reservations:write')
  @ApiOperation({
    summary: 'Modify a reservation',
    description:
      'Change dates (inventory is released and re-reserved atomically; the price is recalculated for new nights), guest counts, guest contact details or notes. ' +
      'Only bookings made through Tirvona or your own software can be modified; a booking that came from an external channel (Airbnb, Booking.com, Agoda) is changed on that channel and this call fails with 409 CHANNEL_OWNED_RESERVATION. Emits reservation.updated.',
  })
  @ApiEnvelope(ReservationV1Dto)
  @ApiStandardErrors({ keyAuth: true, notFound: true, conflict: 'ROOM_NOT_AVAILABLE / RESTRICTION_VIOLATION / CHANNEL_OWNED_RESERVATION / INVALID_STATE_TRANSITION' })
  update(@CurrentApiKey() key: ApiPrincipal, @Param('code') code: string, @Body() dto: UpdateReservationV1Dto, @ReqMeta() meta: RequestMeta) {
    return this.api.updateReservation(key, code, dto as UpdateReservationInput, meta);
  }

  @Get('reservations/:code/payments')
  @RequireScopes('payments:read')
  @ApiOperation({ summary: 'Payments and refunds of a reservation (status, amounts, provider ids; never card or UPI details or gateway secrets)' })
  @ApiStandardErrors({ keyAuth: true, notFound: true })
  payments(@CurrentApiKey() key: ApiPrincipal, @Param('code') code: string) {
    return this.api.reservationPayments(key, code);
  }

  @Get('properties/:slug/rate-plans')
  @RequireScopes('rates:read')
  @ApiOperation({ summary: 'Rate plans of a property with their nightly base prices (minor units) and cancellation policies' })
  @ApiStandardErrors({ keyAuth: true, notFound: true })
  ratePlans(@CurrentApiKey() key: ApiPrincipal, @Param('slug') slug: string) {
    return this.api.listRatePlans(key, slug);
  }

  @Put('properties/:slug/rates')
  @RequireScopes('rates:write')
  @ApiOperation({
    summary: 'Update nightly base prices of rate plans',
    description:
      'Sets basePrice (minor units) for up to 100 rate plans in one atomic request. Existing reservations keep the price they were sold at. The change is queued to every connected channel. Repeating the same request changes nothing.',
  })
  @ApiStandardErrors({ keyAuth: true, notFound: true })
  updateRates(@CurrentApiKey() key: ApiPrincipal, @Param('slug') slug: string, @Body() dto: UpdateRatesV1Dto, @ReqMeta() meta: RequestMeta) {
    return this.api.updateRates(key, slug, dto.updates, meta);
  }

  @Get('properties/:slug/inventory')
  @RequireScopes('inventory:read')
  @ApiOperation({ summary: 'Inventory per room type and night: total, sold, blocked, available, stop-sell and restrictions' })
  @ApiStandardErrors({ keyAuth: true, notFound: true })
  inventory(@CurrentApiKey() key: ApiPrincipal, @Param('slug') slug: string, @Query() q: InventoryQueryV1Dto) {
    return this.api.getInventory(key, slug, q);
  }

  @Put('properties/:slug/inventory')
  @RequireScopes('inventory:write')
  @ApiOperation({
    summary: 'Set restrictions and stop-sell for a room type',
    description:
      'Applies minimumStay, maximumStay, closed, closedToArrival, closedToDeparture and/or stopSell to every night in [from, to). Send null to clear a stay limit. Room counts and physical rooms are managed in the dashboard, not through this API. Emits inventory.updated and is pushed to connected channels.',
  })
  @ApiStandardErrors({ keyAuth: true, notFound: true })
  setInventory(@CurrentApiKey() key: ApiPrincipal, @Param('slug') slug: string, @Body() dto: SetRestrictionsDto, @ReqMeta() meta: RequestMeta) {
    return this.api.setInventory(key, slug, dto, meta);
  }
}
