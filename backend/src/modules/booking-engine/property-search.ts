import { Injectable } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Length, Matches, Max, MaxLength, Min } from 'class-validator';
import { sql } from 'kysely';
import { IsDateOnly } from '../../common/dto';
import { escapeLike } from '../../common/utils';
import { MAX_STAY_NIGHTS } from '../../database/constants';
import { eachNight, formatDateOnly, toDateOnly } from '../../database/common/dates';
import { PropertyStatus, RatePlanStatus, RoomTypeStatus } from '../../database/enums';
import { Db, InjectDb } from '../../database/kysely';
import { DomainValidationError } from '../../database/errors';
import { AvailabilityService } from '../../database/services/availability.service';

/** The most properties one search looks at. Bounds the work of a date-aware search (one availability query per property). */
export const SEARCH_CANDIDATE_CAP = 100;
const AVAILABILITY_CONCURRENCY = 8;

const csv = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.split(',').map((s) => s.trim()).filter(Boolean) : value;

export class PropertySearchQueryDto {
  @ApiPropertyOptional({ example: 'vrindavan', description: 'Free text: matches the property name, city or state' }) @IsOptional() @IsString() @MaxLength(100) q?: string;
  @ApiPropertyOptional({ example: 'Vrindavan', description: 'Exact city (case-insensitive)' }) @IsOptional() @IsString() @MaxLength(100) city?: string;
  @ApiPropertyOptional({ example: 'IN' }) @IsOptional() @Matches(/^[A-Z]{2}$/) country?: string;
  @ApiPropertyOptional({ example: '2026-11-05', description: 'With checkOut: only properties that can host this stay, priced for it' }) @IsOptional() @IsDateOnly() checkIn?: string;
  @ApiPropertyOptional({ example: '2026-11-07' }) @IsOptional() @IsDateOnly() checkOut?: string;
  @ApiPropertyOptional({ example: 2, default: 2 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50) adults?: number;
  @ApiPropertyOptional({ example: 0 }) @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(50) children?: number;
  @ApiPropertyOptional({ example: 1 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(20) rooms?: number;
  @ApiPropertyOptional({ description: 'Minimum nightly price in minor units (paise)' }) @IsOptional() @Type(() => Number) @IsInt() @Min(0) minPrice?: number;
  @ApiPropertyOptional({ description: 'Maximum nightly price in minor units (paise)' }) @IsOptional() @Type(() => Number) @IsInt() @Min(0) maxPrice?: number;
  @ApiPropertyOptional({ example: 'WiFi,Parking', description: 'Comma-separated; a property must offer all of them (case-insensitive)' })
  @IsOptional()
  @Transform(csv)
  @IsString({ each: true })
  @Length(1, 60, { each: true })
  amenities?: string[];
  @ApiPropertyOptional({ enum: ['recommended', 'price_asc', 'price_desc'], default: 'recommended' }) @IsOptional() @IsIn(['recommended', 'price_asc', 'price_desc']) sort?: 'recommended' | 'price_asc' | 'price_desc';
  @ApiPropertyOptional({ default: 1, minimum: 1 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @ApiPropertyOptional({ default: 12, minimum: 1, maximum: 24 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(24) limit?: number;
}

export class PropertySearchItemDto {
  @ApiProperty() slug!: string;
  @ApiProperty() name!: string;
  @ApiPropertyOptional() description?: string;
  @ApiProperty() city!: string;
  @ApiProperty() state!: string;
  @ApiProperty() country!: string;
  @ApiProperty() currency!: string;
  @ApiPropertyOptional({ nullable: true }) image!: { url: string; caption?: string } | null;
  @ApiProperty({ type: [String] }) amenities!: string[];
  @ApiProperty({ description: 'Lowest nightly price (minor units) before tax across active rate plans' }) startingFromPrice!: number;
  @ApiProperty() maxOccupancy!: number;
  @ApiPropertyOptional({ description: 'Present when dates were given: number of nights' }) nights?: number;
  @ApiPropertyOptional({ description: 'Present when dates were given: cheapest bookable nightly price for the stay' }) availableFromNightly?: number;
  @ApiPropertyOptional({ description: 'Present when dates were given: cheapest bookable total for the stay, tax included' }) availableFromTotal?: number;
  @ApiPropertyOptional({ description: 'Present when dates were given: how many room types can host the stay' }) availableRoomTypes?: number;
}

export class PropertySearchResultDto {
  @ApiProperty({ type: [PropertySearchItemDto] }) items!: PropertySearchItemDto[];
  @ApiProperty() page!: number;
  @ApiProperty() limit!: number;
  @ApiProperty() total!: number;
}

async function mapBounded<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

/** Public, cross-property search for the guest-facing site (destination, dates, guests, price, amenities). */
@Injectable()
export class PropertySearchService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly availability: AvailabilityService,
  ) {}

  async search(q: PropertySearchQueryDto): Promise<PropertySearchResultDto> {
    const page = q.page ?? 1;
    const limit = q.limit ?? 12;
    if ((q.checkIn && !q.checkOut) || (!q.checkIn && q.checkOut)) throw new DomainValidationError('checkIn and checkOut must be given together');
    if (q.minPrice !== undefined && q.maxPrice !== undefined && q.minPrice > q.maxPrice) throw new DomainValidationError('minPrice must not exceed maxPrice');
    let stay: { checkIn: Date; checkOut: Date; nights: number } | null = null;
    if (q.checkIn && q.checkOut) {
      const checkIn = toDateOnly(q.checkIn);
      const checkOut = toDateOnly(q.checkOut);
      const nights = eachNight(checkIn, checkOut).length;
      if (nights < 1 || nights > MAX_STAY_NIGHTS) throw new DomainValidationError(`Stay must be 1..${MAX_STAY_NIGHTS} nights`);
      stay = { checkIn, checkOut, nights };
    }

    let query = this.db.selectFrom('properties').where('status', '=', PropertyStatus.ACTIVE);
    if (q.country) query = query.where('country', '=', q.country);
    if (q.city) query = query.where(sql<string>`lower(city)`, '=', q.city.trim().toLowerCase());
    if (q.q?.trim()) {
      const like = `%${escapeLike(q.q.trim())}%`;
      query = query.where((w) => w.or([w('name', 'ilike', like), w('city', 'ilike', like), w('state', 'ilike', like)]));
    }
    if (q.amenities?.length) {
      // Every requested amenity must be offered (case-insensitive).
      const wanted = q.amenities.map((x) => x.trim().toLowerCase());
      query = query.where(sql<boolean>`not exists (select 1 from unnest(${wanted}::text[]) w where not exists (select 1 from unnest(amenities) a where lower(a) = w))`);
    }

    const candidates = await query
      .select(['id', 'slug', 'name', 'description', 'city', 'state', 'country', 'currency', 'images', 'amenities'])
      .orderBy('name')
      .orderBy('id')
      .limit(SEARCH_CANDIDATE_CAP)
      .execute();
    if (!candidates.length) return { items: [], page, limit, total: 0 };

    // Lowest listed price and largest room per property, in two grouped queries (not one per property).
    const ids = candidates.map((c) => c.id);
    const [plans, roomTypes] = await Promise.all([
      this.db.selectFrom('ratePlans').select(['propertyId', (eb) => eb.fn.min('basePrice').as('min')]).where('propertyId', 'in', ids).where('status', '=', RatePlanStatus.ACTIVE).groupBy('propertyId').execute(),
      this.db
        .selectFrom('roomTypes')
        .select(['propertyId', (eb) => eb.fn.min('basePrice').as('min'), (eb) => eb.fn.max('maxOccupancy').as('maxOcc')])
        .where('propertyId', 'in', ids)
        .where('status', '=', RoomTypeStatus.ACTIVE)
        .where('totalRooms', '>', 0)
        .groupBy('propertyId')
        .execute(),
    ]);
    const planMin = new Map(plans.map((p) => [p.propertyId, Number(p.min)]));
    const rooms = new Map(roomTypes.map((r) => [r.propertyId, { min: Number(r.min), maxOcc: Number(r.maxOcc) }]));

    type Row = PropertySearchItemDto;
    let rows: Row[] = candidates.flatMap((c) => {
      const rt = rooms.get(c.id);
      if (!rt) return []; // nothing sellable: not listed
      return [
        {
          slug: c.slug,
          name: c.name,
          description: c.description ? c.description.slice(0, 200) : undefined,
          city: c.city,
          state: c.state,
          country: c.country,
          currency: c.currency,
          image: c.images?.[0] ? { url: c.images[0].url, caption: c.images[0].caption } : null,
          amenities: (c.amenities ?? []).slice(0, 8),
          startingFromPrice: Math.min(planMin.get(c.id) ?? Infinity, rt.min),
          maxOccupancy: rt.maxOcc,
        },
      ];
    });

    if (stay) {
      const guests = (q.adults ?? 2) + (q.children ?? 0);
      const wanted = q.rooms ?? 1;
      const byId = new Map(candidates.map((c) => [c.slug, c.id]));
      const quotes = await mapBounded(rows, AVAILABILITY_CONCURRENCY, async (row) => {
        try {
          const found = await this.availability.search({ propertyId: byId.get(row.slug)!, checkIn: formatDateOnly(stay.checkIn), checkOut: formatDateOnly(stay.checkOut), adults: q.adults ?? 2, children: q.children, rooms: wanted });
          const open = found.filter((rt) => rt.bookable && rt.availableUnits >= wanted && rt.maxOccupancy * wanted >= guests && rt.ratePlans.length > 0);
          if (!open.length) return null;
          const plansOpen = open.flatMap((rt) => rt.ratePlans);
          return { nightly: Math.min(...plansOpen.map((p) => p.nightly)), total: Math.min(...plansOpen.map((p) => p.total)), roomTypes: open.length };
        } catch {
          return null; // e.g. beyond the sellable horizon: not available
        }
      });
      rows = rows.flatMap((row, i) => {
        const quote = quotes[i];
        return quote ? [{ ...row, nights: stay.nights, availableFromNightly: quote.nightly, availableFromTotal: quote.total, availableRoomTypes: quote.roomTypes }] : [];
      });
    }

    const price = (r: Row) => r.availableFromNightly ?? r.startingFromPrice;
    rows = rows.filter((r) => (q.minPrice === undefined || price(r) >= q.minPrice) && (q.maxPrice === undefined || price(r) <= q.maxPrice));
    if (q.sort === 'price_asc') rows.sort((a, b) => price(a) - price(b) || a.name.localeCompare(b.name));
    else if (q.sort === 'price_desc') rows.sort((a, b) => price(b) - price(a) || a.name.localeCompare(b.name));

    return { items: rows.slice((page - 1) * limit, page * limit), page, limit, total: rows.length };
  }
}
