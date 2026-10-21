import { Body, Controller, Delete, Get, Module, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Permission } from '../../common/access/permissions';
import { PropertyAccess } from '../../common/access/property-access.decorator';
import type { AuthUser, RequestMeta } from '../../common/auth/auth-user';
import { CurrentUser, ReqMeta } from '../../common/decorators';
import { ApiEnvelope, ApiStandardErrors } from '../../common/swagger';
import { ParseUuidPipe } from '../../common/utils';
import { PricingService } from './pricing.service';
import {
  CreatePromotionDto,
  CreateRatePlanDto,
  CreateRateRuleDto,
  PromotionDto,
  RateCalendarDayDto,
  RateCalendarQueryDto,
  RatePlanDto,
  RateRuleDto,
  UpdatePromotionDto,
  UpdateRatePlanDto,
  UpdateRateRuleDto,
} from './rates.dto';
import { RateRulesService } from './rate-rules.service';
import { RatesService } from './rates.service';

@ApiTags('Rates')
@Controller()
export class RatesController {
  constructor(
    private readonly rates: RatesService,
    private readonly rules: RateRulesService,
  ) {}

  @Get('properties/:propertyId/rate-plans')
  @PropertyAccess(Permission.PROPERTY_VIEW, { in: 'param', key: 'propertyId', entity: 'property' })
  @ApiOperation({ summary: 'List rate plans' })
  @ApiQuery({ name: 'roomTypeId', required: false })
  @ApiEnvelope(RatePlanDto, { isArray: true })
  @ApiStandardErrors({ notFound: true })
  list(@Param('propertyId', ParseUuidPipe) propertyId: string, @Query('roomTypeId') roomTypeId?: string) {
    return this.rates.listRatePlans(propertyId, roomTypeId);
  }

  @Post('properties/:propertyId/rate-plans')
  @PropertyAccess(Permission.RATES_MANAGE, { in: 'param', key: 'propertyId', entity: 'property' })
  @ApiOperation({ summary: 'Create a rate plan for a room type' })
  @ApiEnvelope(RatePlanDto, { status: 201 })
  @ApiStandardErrors({ notFound: true, conflict: 'DUPLICATE' })
  create(@CurrentUser() user: AuthUser, @ReqMeta() meta: RequestMeta, @Param('propertyId', ParseUuidPipe) propertyId: string, @Body() dto: CreateRatePlanDto) {
    return this.rates.createRatePlan(user, meta, propertyId, dto);
  }

  @Patch('rate-plans/:id')
  @PropertyAccess(Permission.RATES_MANAGE, { in: 'param', key: 'id', entity: 'ratePlan' })
  @ApiOperation({ summary: 'Update a rate plan; price changes are pushed to mapped channels asynchronously' })
  @ApiEnvelope(RatePlanDto)
  @ApiStandardErrors({ notFound: true, conflict: 'INVALID_STATE_TRANSITION' })
  update(@CurrentUser() user: AuthUser, @ReqMeta() meta: RequestMeta, @Param('id', ParseUuidPipe) id: string, @Body() dto: UpdateRatePlanDto) {
    return this.rates.updateRatePlan(user, meta, id, dto);
  }

  @Delete('rate-plans/:id')
  @PropertyAccess(Permission.RATES_MANAGE, { in: 'param', key: 'id', entity: 'ratePlan' })
  @ApiOperation({ summary: 'Archive a rate plan (existing reservations keep their frozen prices)' })
  @ApiEnvelope(RatePlanDto)
  @ApiStandardErrors({ notFound: true })
  archive(@CurrentUser() user: AuthUser, @ReqMeta() meta: RequestMeta, @Param('id', ParseUuidPipe) id: string) {
    return this.rates.archiveRatePlan(user, meta, id);
  }

  @Get('properties/:propertyId/rate-rules')
  @PropertyAccess(Permission.PROPERTY_VIEW, { in: 'param', key: 'propertyId', entity: 'property' })
  @ApiOperation({ summary: 'List date-level / seasonal rate rules' })
  @ApiQuery({ name: 'roomTypeId', required: false })
  @ApiEnvelope(RateRuleDto, { isArray: true })
  @ApiStandardErrors({ notFound: true })
  listRules(@Param('propertyId', ParseUuidPipe) propertyId: string, @Query('roomTypeId') roomTypeId?: string) {
    return this.rules.list(propertyId, roomTypeId);
  }

  @Post('properties/:propertyId/rate-rules')
  @PropertyAccess(Permission.RATES_MANAGE, { in: 'param', key: 'propertyId', entity: 'property' })
  @ApiOperation({
    summary: 'Create a rate rule: a fixed price or a percentage change for a date range, optionally on certain weekdays or one rate plan',
    description:
      'When several rules match a night: highest priority wins; then a rule for the rate plan over one for the whole room type; then a weekday rule over an every-day rule; then the shorter range; then the newest. Two active rules with the same priority and scope that overlap are refused (RATE_RULE_CONFLICT). Existing reservations keep the prices they were sold at. Changes are queued to connected channels.',
  })
  @ApiEnvelope(RateRuleDto, { status: 201 })
  @ApiStandardErrors({ notFound: true, conflict: 'RATE_RULE_CONFLICT' })
  createRule(@CurrentUser() user: AuthUser, @ReqMeta() meta: RequestMeta, @Param('propertyId', ParseUuidPipe) propertyId: string, @Body() dto: CreateRateRuleDto) {
    return this.rules.create(user, meta, propertyId, dto);
  }

  @Patch('rate-rules/:id')
  @PropertyAccess(Permission.RATES_MANAGE, { in: 'param', key: 'id', entity: 'rateRule' })
  @ApiOperation({ summary: 'Update or (de)activate a rate rule' })
  @ApiEnvelope(RateRuleDto)
  @ApiStandardErrors({ notFound: true, conflict: 'RATE_RULE_CONFLICT' })
  updateRule(@CurrentUser() user: AuthUser, @ReqMeta() meta: RequestMeta, @Param('id', ParseUuidPipe) id: string, @Body() dto: UpdateRateRuleDto) {
    return this.rules.update(user, meta, id, dto);
  }

  @Delete('rate-rules/:id')
  @PropertyAccess(Permission.RATES_MANAGE, { in: 'param', key: 'id', entity: 'rateRule' })
  @ApiOperation({ summary: 'Deactivate a rate rule (kept for history)' })
  @ApiEnvelope(RateRuleDto)
  @ApiStandardErrors({ notFound: true })
  deactivateRule(@CurrentUser() user: AuthUser, @ReqMeta() meta: RequestMeta, @Param('id', ParseUuidPipe) id: string) {
    return this.rules.deactivate(user, meta, id);
  }

  @Get('properties/:propertyId/rate-calendar')
  @PropertyAccess(Permission.PROPERTY_VIEW, { in: 'param', key: 'propertyId', entity: 'property' })
  @ApiOperation({ summary: 'Effective nightly price per date for a rate plan, and the rule that set it' })
  @ApiEnvelope(RateCalendarDayDto, { isArray: true })
  @ApiStandardErrors({ notFound: true })
  rateCalendar(@Param('propertyId', ParseUuidPipe) propertyId: string, @Query() q: RateCalendarQueryDto) {
    return this.rules.calendar(propertyId, q);
  }

  @Get('properties/:propertyId/promotions')
  @PropertyAccess(Permission.PROPERTY_VIEW, { in: 'param', key: 'propertyId', entity: 'property' })
  @ApiOperation({ summary: 'List promo codes' })
  @ApiEnvelope(PromotionDto, { isArray: true })
  @ApiStandardErrors({ notFound: true })
  listPromotions(@Param('propertyId', ParseUuidPipe) propertyId: string) {
    return this.rates.listPromotions(propertyId);
  }

  @Post('properties/:propertyId/promotions')
  @PropertyAccess(Permission.RATES_MANAGE, { in: 'param', key: 'propertyId', entity: 'property' })
  @ApiOperation({ summary: 'Create a promo code for the booking engine' })
  @ApiEnvelope(PromotionDto, { status: 201 })
  @ApiStandardErrors({ notFound: true, conflict: 'DUPLICATE' })
  createPromotion(@CurrentUser() user: AuthUser, @ReqMeta() meta: RequestMeta, @Param('propertyId', ParseUuidPipe) propertyId: string, @Body() dto: CreatePromotionDto) {
    return this.rates.createPromotion(user, meta, propertyId, dto);
  }

  @Patch('promotions/:id')
  @PropertyAccess(Permission.RATES_MANAGE, { in: 'param', key: 'id', entity: 'promotion' })
  @ApiOperation({ summary: 'Update a promo code' })
  @ApiEnvelope(PromotionDto)
  @ApiStandardErrors({ notFound: true })
  updatePromotion(@CurrentUser() user: AuthUser, @ReqMeta() meta: RequestMeta, @Param('id', ParseUuidPipe) id: string, @Body() dto: UpdatePromotionDto) {
    return this.rates.updatePromotion(user, meta, id, dto);
  }

  @Delete('promotions/:id')
  @PropertyAccess(Permission.RATES_MANAGE, { in: 'param', key: 'id', entity: 'promotion' })
  @ApiOperation({ summary: 'Deactivate a promo code' })
  @ApiEnvelope(PromotionDto)
  @ApiStandardErrors({ notFound: true })
  deletePromotion(@CurrentUser() user: AuthUser, @ReqMeta() meta: RequestMeta, @Param('id', ParseUuidPipe) id: string) {
    return this.rates.deletePromotion(user, meta, id);
  }
}

@Module({ controllers: [RatesController], providers: [RatesService, RateRulesService, PricingService], exports: [RatesService, RateRulesService, PricingService] })
export class RatesModule {}
