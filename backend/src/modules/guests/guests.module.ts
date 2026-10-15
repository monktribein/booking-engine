import { Body, Controller, Get, Injectable, Module, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags, PartialType, OmitType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsEmail, IsEnum, IsUUID, IsOptional, IsString, Length, Matches, ValidateNested } from 'class-validator';
import { Permission } from '../../common/access/permissions';
import { PropertyAccess } from '../../common/access/property-access.decorator';
import type { AuthUser, PropertyAccessContext, RequestMeta } from '../../common/auth/auth-user';
import { CurrentUser, PropertyCtx, ReqMeta } from '../../common/decorators';
import { IsDateOnly, PropertyScopedPageQueryDto } from '../../common/dto';
import { ApiEnvelope, ApiStandardErrors } from '../../common/swagger';
import { Page, ParseUuidPipe, escapeLike, pageParams } from '../../common/utils';
import { encryptSecret } from '../../database/common/crypto';
import type { Guest } from '../../database/db-types';
import { GuestDocumentType } from '../../database/enums';
import { NotFoundError } from '../../database/errors';
import { Db, InjectDb, j } from '../../database/kysely';
import { AuditLogger } from '../audit/audit.logger';

// ------------------------------------------------------------------ DTOs

export class GuestDocumentInputDto {
  @ApiProperty({ enum: GuestDocumentType }) @IsEnum(GuestDocumentType) type!: GuestDocumentType;
  @ApiProperty({ description: 'Stored encrypted; only the last 4 characters are ever returned' }) @IsString() @Length(4, 40) number!: string;
  @ApiPropertyOptional({ example: 'IN' }) @IsOptional() @Matches(/^[A-Z]{2}$/) issuingCountry?: string;
  @ApiPropertyOptional({ example: '2030-01-31' }) @IsOptional() @IsDateOnly() expiresAt?: string;
}

export class CreateGuestDto {
  @ApiProperty() @IsUUID() propertyId!: string;
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
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly audit: AuditLogger,
  ) {}

  async list(propertyId: string, q: GuestListQueryDto): Promise<Page<Guest>> {
    const p = pageParams(q.page, q.limit);
    let query = this.db.selectFrom('guests').where('propertyId', '=', propertyId);
    if (q.q?.trim()) {
      // Property-scoped substring search is fine at PMS scale; add a trigram index (pg_trgm) for very large guest books.
      const like = `%${escapeLike(q.q.trim())}%`;
      query = query.where((w) => w.or([w('firstName', 'ilike', like), w('lastName', 'ilike', like), w('email', 'ilike', like), w('phone', 'ilike', like)]));
    }
    const [items, total] = await Promise.all([
      query.selectAll().orderBy('createdAt', 'desc').orderBy('id').offset(p.skip).limit(p.limit).execute(),
      query.select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow(),
    ]);
    return { items, page: p.page, limit: p.limit, total: Number(total.n) };
  }

  async get(id: string): Promise<Guest> {
    const g = await this.db.selectFrom('guests').selectAll().where('id', '=', id).executeTakeFirst();
    if (!g) throw new NotFoundError('Guest', id);
    return g;
  }

  async create(user: AuthUser, meta: RequestMeta, propertyId: string, dto: CreateGuestDto): Promise<Guest> {
    const g = await this.db
      .insertInto('guests')
      .values({
        propertyId,
        firstName: dto.firstName.trim(),
        lastName: dto.lastName?.trim() ?? '',
        email: dto.email?.trim().toLowerCase() ?? null,
        phone: dto.phone ?? null,
        country: dto.country ?? null,
        documents: j((dto.documents ?? []).map(toStoredDocument)),
        notes: dto.notes ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await this.audit.log({ user, meta }, { action: 'guest.create', entityType: 'Guest', entityId: g.id, propertyId });
    return g;
  }

  async update(user: AuthUser, meta: RequestMeta, id: string, dto: UpdateGuestDto): Promise<Guest> {
    const doc = await this.get(id);
    const set: Record<string, unknown> = {};
    if (dto.firstName !== undefined) set.firstName = dto.firstName.trim();
    if (dto.lastName !== undefined) set.lastName = dto.lastName.trim();
    if (dto.email !== undefined) set.email = dto.email.trim().toLowerCase();
    if (dto.phone !== undefined) set.phone = dto.phone;
    if (dto.country !== undefined) set.country = dto.country;
    if (dto.notes !== undefined) set.notes = dto.notes;
    if (dto.documents) set.documents = j(dto.documents.map(toStoredDocument));
    const updated = Object.keys(set).length ? await this.db.updateTable('guests').set(set).where('id', '=', id).returningAll().executeTakeFirstOrThrow() : doc;
    await this.audit.log({ user, meta }, { action: 'guest.update', entityType: 'Guest', entityId: id, propertyId: doc.propertyId, metadata: { fields: Object.keys(dto) } });
    return updated;
  }
}

function toStoredDocument(d: GuestDocumentInputDto) {
  const number = d.number.replace(/\s+/g, '');
  return {
    type: d.type,
    numberEncrypted: encryptSecret(number),
    numberLast4: number.slice(-4),
    ...(d.issuingCountry ? { issuingCountry: d.issuingCountry } : {}),
    ...(d.expiresAt ? { expiresAt: d.expiresAt } : {}),
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
  get(@Param('id', ParseUuidPipe) id: string) {
    return this.guests.get(id);
  }

  @Patch(':id')
  @PropertyAccess(Permission.GUESTS_MANAGE, { in: 'param', key: 'id', entity: 'guest' })
  @ApiOperation({ summary: 'Update a guest' })
  @ApiEnvelope(GuestDto)
  @ApiStandardErrors({ notFound: true })
  update(@CurrentUser() user: AuthUser, @ReqMeta() meta: RequestMeta, @Param('id', ParseUuidPipe) id: string, @Body() dto: UpdateGuestDto) {
    return this.guests.update(user, meta, id, dto);
  }
}

@Module({ controllers: [GuestsController], providers: [GuestsService], exports: [GuestsService] })
export class GuestsModule {}
