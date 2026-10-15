import { Body, Controller, Get, HttpCode, Injectable, Module, OnModuleInit, Param, Post, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiPropertyOptional, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsEnum, IsInt, IsMongoId, IsOptional, IsString, Length, Min } from 'class-validator';
import type { Request } from 'express';
import type { Types } from 'mongoose';
import { Permission } from '../../common/access/permissions';
import { PropertyAccess } from '../../common/access/property-access.decorator';
import type { AuthUser, RequestMeta } from '../../common/auth/auth-user';
import { CurrentUser, Public, ReqMeta } from '../../common/decorators';
import { ApiEnvelope, ApiStandardErrors } from '../../common/swagger';
import { ParseObjectIdPipe, toObjectId } from '../../common/utils';
import { PaymentProvider, PaymentStatus, RefundStatus } from '../../database/enums';
import { JobContext, JobHandler, JobHandlerRegistry } from '../../jobs/job-handler';
import { QUEUES } from '../../jobs/queues';
import { PaymentsService } from './payments.service';
import { RazorpayProvider } from './providers/razorpay.provider';

// ------------------------------------------------------------------ DTOs

export class CreatePaymentDto {
  @ApiProperty() @IsMongoId() reservationId!: string;
  @ApiProperty({ enum: [PaymentProvider.RAZORPAY, PaymentProvider.CASH, PaymentProvider.BANK_TRANSFER, PaymentProvider.OTHER] })
  @IsEnum([PaymentProvider.RAZORPAY, PaymentProvider.CASH, PaymentProvider.BANK_TRANSFER, PaymentProvider.OTHER])
  provider!: PaymentProvider;
  @ApiPropertyOptional({ description: 'Minor units; defaults to the balance due' }) @IsOptional() @IsInt() @Min(1) amount?: number;
  @ApiPropertyOptional({ description: 'Receipt / transfer reference (offline payments)' }) @IsOptional() @IsString() @Length(1, 100) reference?: string;
}

export class VerifyPaymentDto {
  @ApiProperty({ example: 'order_Nxxxxxxxx' }) @IsString() @Length(5, 60) razorpayOrderId!: string;
  @ApiProperty({ example: 'pay_Nxxxxxxxx' }) @IsString() @Length(5, 60) razorpayPaymentId!: string;
  @ApiProperty() @IsString() @Length(64, 64) razorpaySignature!: string;
}

export class RefundDto {
  @ApiPropertyOptional({ description: 'Minor units; defaults to everything refundable (full refund)' }) @IsOptional() @IsInt() @Min(1) amount?: number;
  @ApiProperty({ example: 'Guest complaint' }) @IsString() @Length(1, 500) reason!: string;
}

export class RefundResponseDto {
  @ApiProperty() _id!: string;
  @ApiProperty() paymentId!: string;
  @ApiProperty() amount!: number;
  @ApiProperty() currency!: string;
  @ApiProperty({ enum: RefundStatus }) status!: RefundStatus;
  @ApiPropertyOptional() providerRefundId?: string;
  @ApiPropertyOptional() reason?: string;
}

export class PaymentResponseDto {
  @ApiProperty() _id!: string;
  @ApiProperty() reservationId!: string;
  @ApiProperty({ enum: PaymentProvider }) provider!: PaymentProvider;
  @ApiPropertyOptional() providerOrderId?: string;
  @ApiPropertyOptional() providerPaymentId?: string;
  @ApiProperty() amount!: number;
  @ApiProperty() amountRefunded!: number;
  @ApiProperty() currency!: string;
  @ApiProperty({ enum: PaymentStatus }) status!: PaymentStatus;
  @ApiPropertyOptional() paidAt?: string;
  @ApiPropertyOptional({ type: [RefundResponseDto] }) refunds?: RefundResponseDto[];
}

export class CheckoutDto {
  @ApiProperty() provider!: string;
  @ApiProperty({ description: 'Public key for Razorpay Checkout' }) keyId!: string;
  @ApiProperty() orderId!: string;
  @ApiProperty() amount!: number;
  @ApiProperty() currency!: string;
  @ApiProperty() reservationCode!: string;
  @ApiProperty({ type: Object }) prefill!: Record<string, string>;
}

export class CreatePaymentResultDto {
  @ApiProperty({ type: PaymentResponseDto }) payment!: PaymentResponseDto;
  @ApiPropertyOptional({ type: CheckoutDto, nullable: true, description: 'Pass to Razorpay Checkout (online payments)' }) checkout!: CheckoutDto | null;
}

// ------------------------------------------------------------------ controller

@ApiTags('Payments')
@Controller('payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Post('create')
  @PropertyAccess(Permission.PAYMENTS_COLLECT, { in: 'body', key: 'reservationId', entity: 'reservation' })
  @ApiOperation({ summary: 'Take a payment: Razorpay order for online payment, or record cash/bank transfer' })
  @ApiEnvelope(CreatePaymentResultDto, { status: 201 })
  @ApiStandardErrors({ notFound: true })
  create(@CurrentUser() user: AuthUser, @ReqMeta() meta: RequestMeta, @Body() dto: CreatePaymentDto) {
    return this.payments.create(user, meta, { ...dto, reservationId: toObjectId(dto.reservationId, 'reservationId') });
  }

  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('verify')
  @HttpCode(200)
  @ApiOperation({ summary: 'Verify the Razorpay Checkout signature and capture the payment (guest browser callback)' })
  @ApiEnvelope(PaymentResponseDto)
  @ApiStandardErrors({ auth: false, notFound: true })
  verify(@Body() dto: VerifyPaymentDto, @ReqMeta() meta: RequestMeta) {
    return this.payments.verifyCheckout({ orderId: dto.razorpayOrderId, paymentId: dto.razorpayPaymentId, signature: dto.razorpaySignature }, meta);
  }

  @Public()
  @Throttle({ default: { limit: 600, ttl: 60_000 } })
  @Post('webhook')
  @HttpCode(200)
  @ApiOperation({ summary: 'Razorpay webhook (X-Razorpay-Signature over the raw body). Stored, deduplicated, processed on the payment queue.' })
  @ApiStandardErrors({ auth: false })
  webhook(@Req() req: Request & { rawBody?: Buffer }) {
    return this.payments.receiveWebhook(req.rawBody ?? Buffer.from(''), req.headers, req.body);
  }

  @Get()
  @PropertyAccess(Permission.PAYMENTS_VIEW, { in: 'query', key: 'reservationId', entity: 'reservation' })
  @ApiQuery({ name: 'reservationId', required: true })
  @ApiOperation({ summary: 'Payments of a reservation' })
  @ApiEnvelope(PaymentResponseDto, { isArray: true })
  @ApiStandardErrors({ notFound: true })
  list(@Query('reservationId') reservationId: string) {
    return this.payments.listForReservation(toObjectId(reservationId, 'reservationId'));
  }

  @Get(':id')
  @PropertyAccess(Permission.PAYMENTS_VIEW, { in: 'param', key: 'id', entity: 'payment' })
  @ApiOperation({ summary: 'Payment status, with its refunds' })
  @ApiEnvelope(PaymentResponseDto)
  @ApiStandardErrors({ notFound: true })
  get(@Param('id', ParseObjectIdPipe) id: Types.ObjectId) {
    return this.payments.get(id);
  }

  @Post(':id/refund')
  @PropertyAccess(Permission.PAYMENTS_REFUND, { in: 'param', key: 'id', entity: 'payment' })
  @ApiOperation({ summary: 'Full or partial refund (queued; executed at the gateway by the payment worker)' })
  @ApiEnvelope(RefundResponseDto, { status: 201 })
  @ApiStandardErrors({ notFound: true, conflict: 'INVALID_STATE_TRANSITION' })
  refund(@CurrentUser() user: AuthUser, @ReqMeta() meta: RequestMeta, @Param('id', ParseObjectIdPipe) id: Types.ObjectId, @Body() dto: RefundDto) {
    return this.payments.requestRefund(user, meta, id, dto);
  }
}

// ------------------------------------------------------------------ worker

@Injectable()
export class PaymentJobHandler implements JobHandler<'payment'>, OnModuleInit {
  readonly queue = QUEUES.PAYMENT;
  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly payments: PaymentsService,
  ) {}
  onModuleInit() {
    this.registry.register(this);
  }
  handle(ctx: JobContext<'payment'>) {
    return ctx.data.kind === 'WEBHOOK' ? this.payments.processWebhookEvent(ctx.data.webhookEventId, ctx) : this.payments.processRefund(ctx.data.refundId, ctx);
  }
}

@Module({
  controllers: [PaymentsController],
  providers: [PaymentsService, RazorpayProvider, PaymentJobHandler],
  exports: [PaymentsService, RazorpayProvider],
})
export class PaymentsModule {}
