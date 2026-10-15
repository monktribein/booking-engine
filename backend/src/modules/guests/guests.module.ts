import { Body, Controller, Get, Injectable, Module, Param, Patch, Post, Query } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags, PartialType, OmitType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsEmail, IsEnum, IsMongoId, IsOptional, IsString, Length, Matches, ValidateNested } from 'class-validator';
import { Connection, Types } from 'mongoose';
import { Permission } from '../../common/access/permissions';
import { PropertyAccess } from '../../common/access/property-access.decorator';
import type { AuthUser, PropertyAccessContext, RequestMeta } from '../../common/auth/auth-user';
import { CurrentUser, PropertyCtx, ReqMeta } from '../../common/decorators';
import { IsDateOnly, PropertyScopedPageQueryDto } from '../../common/dto';
import { ApiEnvelope, ApiStandardErrors } from '../../common/swagger';
import { Page, ParseObjectIdPipe, escapeRegex, pageParams } from '../../common/utils';
import { encryptSecret } from '../../database/common/crypto';
import { toDateOnly } from '../../database/common/dates';
import { GuestDocumentType } from '../../database/enums';
import { NotFoundError } from '../../database/errors';
import { Models, getModels } from '../../database/models';
import type { Guest } from '../../database/schemas/guest.schema';
import { AuditLogger } from '../audit/audit.logger';

// ------------------------------------------------------------------ DTOs

export class GuestDocumentInputDto {
  @ApiProperty({ enum: GuestDocumentType }) @IsEnum(GuestDocumentType) type!: GuestDocumentType;
  @ApiProperty({ description: 'Stored encrypted; only the last 4 characters are ever returned' }) @IsString() @Length(4, 40) number!: string;
  @ApiPropertyOptional({ example: 'IN' }) @IsOptional() @Matches(/^[A-Z]{2}$/) issuingCountry?: string;
  @ApiPropertyOptional({ example: '2030-01-31' }) @IsOptional() @IsDateOnly() expiresAt?: string;
}

export class CreateGuestDto {
  @ApiProperty() @IsMongoId() propertyId!: string;
  @ApiProperty() @IsString() @Length(1, 100) firstName!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(0, 100) lastName?: string;
  @ApiPropertyOptional() @IsOptional() @IsEmail() email?: string;
  @ApiPropertyOptional({ example: '+919811111111' }) @IsOptional() @Matches(/^\+[1-9]\d{6,14}$/) phone?: string;
  @ApiPropertyOptional({ example: 'IN' }) @IsOptional() @Matches(/^[A-Z]{2}$/) country?: string;
  @ApiPropertyOptional({ type: [GuestDocumentInputDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => GuestDocumentInputDto)
  documents?: GuestDocumentInputDto[];
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(0, 5000) notes?: string;
}

export class UpdateGuestDto extends PartialType(OmitType(CreateGuestDto, ['propertyId'] as const)) {}

export class GuestListQueryDto extends PropertyScopedPageQueryDto {
  @ApiPropertyOptional({ description: 'Name, email or phone contains' }) @IsOptional() @IsString() @Length(1, 100) q?: string;
}

class GuestDocumentDto {
  @ApiProperty({ enum: GuestDocumentType }) type!: GuestDocumentType;
  @ApiPropertyOptional() numberLast4?: string;
  @ApiPropertyOptional() issuingCountry?: string;
  @ApiPropertyOptional() expiresAt?: string;
}

export class GuestDto {
  @ApiProperty() _id!: string;
  @ApiProperty() propertyId!: string;
  @ApiProperty() firstName!: string;
  @ApiProperty() lastName!: string;
  @ApiPropertyOptional() email?: string;
  @ApiPropertyOptional() phone?: string;
  @ApiPropertyOptional() country?: string;
  @ApiProperty({ type: [GuestDocumentDto] }) documents!: GuestDocumentDto[];
  @ApiPropertyOptional() notes?: string;
  @ApiProperty() createdAt!: string;
}

// ------------------------------------------------------------------ service

@Injectable()
export class GuestsService {
  private readonly m: Models;

  constructor(
    @InjectConnection() connection: Connection,
    private readonly audit: AuditLogger,
  ) {
    this.m = getModels(connection);
  }

  async list(propertyId: Types.ObjectId, q: GuestListQueryDto): Promise<Page<Guest>> {
    const p = pageParams(q.page, q.limit);
    const rx = q.q ? new RegExp(escapeRegex(q.q), 'i') : null;
    // Property-scoped regex search is fine at PMS scale; move to Atlas Search for large guest books.
    const filter = { propertyId, ...(rx ? { $or: [{ firstName: rx }, { lastName: rx }, { email: rx }, { phone: rx }] } : {}) };
    const [items, total] = await Promise.all([
      this.m.Guest.find(filter).sort({ createdAt: -1 }).skip(p.skip).limit(p.limit).lean(),
      this.m.Guest.countDocuments(filter),
    ]);
    return { items, page: p.page, limit: p.limit, total };
  }

  async get(id: Types.ObjectId): Promise<Guest> {
    const g = await this.m.Guest.findById(id).lean();
    if (!g) throw new NotFoundError('Guest', id);
    return g;
  }

  async create(user: AuthUser, meta: RequestMeta, propertyId: Types.ObjectId, dto: CreateGuestDto): Promise<Guest> {
    const { propertyId: _p, documents, ...fields } = dto;
    const [g] = await this.m.Guest.create([{ ...fields, propertyId, documents: (documents ?? []).map(toStoredDocument) }]);
    await this.audit.log({ user, meta }, { action: 'guest.create', entityType: 'Guest', entityId: g._id, propertyId });
    return this.get(g._id);
  }

  async update(user: AuthUser, meta: RequestMeta, id: Types.ObjectId, dto: UpdateGuestDto): Promise<Guest> {
    const doc = await this.m.Guest.findById(id);
    if (!doc) throw new NotFoundError('Guest', id);
    const { documents, ...fields } = dto;
    doc.set(fields);
    if (documents) doc.set('documents', documents.map(toStoredDocument));
    await doc.save();
    await this.audit.log({ user, meta }, { action: 'guest.update', entityType: 'Guest', entityId: id, propertyId: doc.propertyId, metadata: { fields: Object.keys(dto) } });
    return this.get(id);
  }
}

function toStoredDocument(d: GuestDocumentInputDto) {
  const number = d.number.replace(/\s+/g, '');
  return {
    type: d.type,
    numberEncrypted: encryptSecret(number),
    numberLast4: number.slice(-4),
    issuingCountry: d.issuingCountry,
    expiresAt: d.expiresAt ? toDateOnly(d.expiresAt) : undefined,
  };
}

// ------------------------------------------------------------------ controller

@ApiTags('Guests')
@Controller('guests')
export class GuestsController {
  constructor(private readonly guests: GuestsService) {}

  @Get()
  @PropertyAccess(Permission.GUESTS_VIEW, { in: 'query', key: 'propertyId', entity: 'property' })
  @ApiOperation({ summary: "Search a property's guest book" })
  @ApiEnvelope(GuestDto, { paginated: true })
  @ApiStandardErrors()
  list(@PropertyCtx() ctx: PropertyAccessContext, @Query() q: GuestListQueryDto) {
    return this.guests.list(ctx.propertyId, q);
  }

  @Post()
  @PropertyAccess(Permission.GUESTS_MANAGE, { in: 'body', key: 'propertyId', entity: 'property' })
  @ApiOperation({ summary: 'Create a guest (ID document numbers are encrypted at rest)' })
  @ApiEnvelope(GuestDto, { status: 201 })
  @ApiStandardErrors()
  create(@CurrentUser() user: AuthUser, @ReqMeta() meta: RequestMeta, @PropertyCtx() ctx: PropertyAccessContext, @Body() dto: CreateGuestDto) {
    return this.guests.create(user, meta, ctx.propertyId, dto);
  }

  @Get(':id')
  @PropertyAccess(Permission.GUESTS_VIEW, { in: 'param', key: 'id', entity: 'guest' })
  @ApiOperation({ summary: 'Get a guest' })
  @ApiEnvelope(GuestDto)
  @ApiStandardErrors({ notFound: true })
  get(@Param('id', ParseObjectIdPipe) id: Types.ObjectId) {
    return this.guests.get(id);
  }

  @Patch(':id')
  @PropertyAccess(Permission.GUESTS_MANAGE, { in: 'param', key: 'id', entity: 'guest' })
  @ApiOperation({ summary: 'Update a guest' })
  @ApiEnvelope(GuestDto)
  @ApiStandardErrors({ notFound: true })
  update(@CurrentUser() user: AuthUser, @ReqMeta() meta: RequestMeta, @Param('id', ParseObjectIdPipe) id: Types.ObjectId, @Body() dto: UpdateGuestDto) {
    return this.guests.update(user, meta, id, dto);
  }
}

@Module({ controllers: [GuestsController], providers: [GuestsService], exports: [GuestsService] })
export class GuestsModule {}
