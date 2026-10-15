import { Body, Controller, Delete, Get, Module, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Types } from 'mongoose';
import { Permission } from '../../common/access/permissions';
import { PropertyAccess } from '../../common/access/property-access.decorator';
import type { AuthUser, RequestMeta } from '../../common/auth/auth-user';
import { CurrentUser, ReqMeta } from '../../common/decorators';
import { ApiEnvelope, ApiStandardErrors } from '../../common/swagger';
import { ParseObjectIdPipe } from '../../common/utils';
import { PricingService } from './pricing.service';
import {
  CreatePromotionDto,
  CreateRatePlanDto,
  PromotionDto,
  RatePlanDto,
  UpdatePromotionDto,
  UpdateRatePlanDto,
} from './rates.dto';
import { RatesService } from './rates.service';

@ApiTags('Rates')
@Controller()
export class RatesController {
  constructor(private readonly rates: RatesService) {}

  @Get('properties/:propertyId/rate-plans')
  @PropertyAccess(Permission.PROPERTY_VIEW, { in: 'param', key: 'propertyId', entity: 'property' })
  @ApiOperation({ summary: 'List rate plans' })
  @ApiQuery({ name: 'roomTypeId', required: false })
  @ApiEnvelope(RatePlanDto, { isArray: true })
  @ApiStandardErrors({ notFound: true })
  list(@Param('propertyId', ParseObjectIdPipe) propertyId: Types.ObjectId, @Query('roomTypeId') roomTypeId?: string) {
    return this.rates.listRatePlans(propertyId, roomTypeId);
  }

  @Post('properties/:propertyId/rate-plans')
  @PropertyAccess(Permission.RATES_MANAGE, { in: 'param', key: 'propertyId', entity: 'property' })
  @ApiOperation({ summary: 'Create a rate plan for a room type' })
  @ApiEnvelope(RatePlanDto, { status: 201 })
  @ApiStandardErrors({ notFound: true, conflict: 'DUPLICATE' })
  create(@CurrentUser() user: AuthUser, @ReqMeta() meta: RequestMeta, @Param('propertyId', ParseObjectIdPipe) propertyId: Types.ObjectId, @Body() dto: CreateRatePlanDto) {
    return this.rates.createRatePlan(user, meta, propertyId, dto);
  }

  @Patch('rate-plans/:id')
  @PropertyAccess(Permission.RATES_MANAGE, { in: 'param', key: 'id', entity: 'ratePlan' })
  @ApiOperation({ summary: 'Update a rate plan; price changes are pushed to mapped channels asynchronously' })
  @ApiEnvelope(RatePlanDto)
  @ApiStandardErrors({ notFound: true, conflict: 'INVALID_STATE_TRANSITION' })
  update(@CurrentUser() user: AuthUser, @ReqMeta() meta: RequestMeta, @Param('id', ParseObjectIdPipe) id: Types.ObjectId, @Body() dto: UpdateRatePlanDto) {
    return this.rates.updateRatePlan(user, meta, id, dto);
  }

  @Delete('rate-plans/:id')
  @PropertyAccess(Permission.RATES_MANAGE, { in: 'param', key: 'id', entity: 'ratePlan' })
  @ApiOperation({ summary: 'Archive a rate plan (existing reservations keep their frozen prices)' })
  @ApiEnvelope(RatePlanDto)
  @ApiStandardErrors({ notFound: true })
  archive(@CurrentUser() user: AuthUser, @ReqMeta() meta: RequestMeta, @Param('id', ParseObjectIdPipe) id: Types.ObjectId) {
    return this.rates.archiveRatePlan(user, meta, id);
  }

  @Get('properties/:propertyId/promotions')
  @PropertyAccess(Permission.PROPERTY_VIEW, { in: 'param', key: 'propertyId', entity: 'property' })
  @ApiOperation({ summary: 'List promo codes' })
  @ApiEnvelope(PromotionDto, { isArray: true })
  @ApiStandardErrors({ notFound: true })
  listPromotions(@Param('propertyId', ParseObjectIdPipe) propertyId: Types.ObjectId) {
    return this.rates.listPromotions(propertyId);
  }

  @Post('properties/:propertyId/promotions')
  @PropertyAccess(Permission.RATES_MANAGE, { in: 'param', key: 'propertyId', entity: 'property' })
  @ApiOperation({ summary: 'Create a promo code for the booking engine' })
  @ApiEnvelope(PromotionDto, { status: 201 })
  @ApiStandardErrors({ notFound: true, conflict: 'DUPLICATE' })
  createPromotion(@CurrentUser() user: AuthUser, @ReqMeta() meta: RequestMeta, @Param('propertyId', ParseObjectIdPipe) propertyId: Types.ObjectId, @Body() dto: CreatePromotionDto) {
    return this.rates.createPromotion(user, meta, propertyId, dto);
  }

  @Patch('promotions/:id')
  @PropertyAccess(Permission.RATES_MANAGE, { in: 'param', key: 'id', entity: 'promotion' })
  @ApiOperation({ summary: 'Update a promo code' })
  @ApiEnvelope(PromotionDto)
  @ApiStandardErrors({ notFound: true })
  updatePromotion(@CurrentUser() user: AuthUser, @ReqMeta() meta: RequestMeta, @Param('id', ParseObjectIdPipe) id: Types.ObjectId, @Body() dto: UpdatePromotionDto) {
    return this.rates.updatePromotion(user, meta, id, dto);
  }

  @Delete('promotions/:id')
  @PropertyAccess(Permission.RATES_MANAGE, { in: 'param', key: 'id', entity: 'promotion' })
  @ApiOperation({ summary: 'Deactivate a promo code' })
  @ApiEnvelope(PromotionDto)
  @ApiStandardErrors({ notFound: true })
  deletePromotion(@CurrentUser() user: AuthUser, @ReqMeta() meta: RequestMeta, @Param('id', ParseObjectIdPipe) id: Types.ObjectId) {
    return this.rates.deletePromotion(user, meta, id);
  }
}

@Module({ controllers: [RatesController], providers: [RatesService, PricingService], exports: [RatesService, PricingService] })
export class RatesModule {}
