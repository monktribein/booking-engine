import { Body, Controller, HttpCode, Injectable, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsOptional, IsString, IsUUID, Length, ValidateNested } from 'class-validator';
import { Permission } from '../../common/access/permissions';
import { PropertyAccess } from '../../common/access/property-access.decorator';
import { PropertyAccessService } from '../../common/access/property-access.service';
import type { AuthUser, PropertyAccessContext, RequestMeta } from '../../common/auth/auth-user';
import { CurrentUser, PropertyCtx, ReqMeta } from '../../common/decorators';
import { ApiStandardErrors } from '../../common/swagger';
import { ParseUuidPipe } from '../../common/utils';
import { addDays, formatDateOnly, todayIn } from '../../database/common/dates';
import { ReservationStatus } from '../../database/enums';
import { DomainError, DomainValidationError, ForbiddenError, NotFoundError } from '../../database/errors';
import { Db, InjectDb } from '../../database/kysely';
import { ReservationService } from '../../database/services/reservation.service';
import { AuditLogger } from '../audit/audit.logger';

export const CSV_SOURCE = 'CSV_IMPORT';
const MAX_BYTES = 1024 * 1024;
const MAX_ROWS = 1000;

// ------------------------------------------------------------------ CSV reader (RFC 4180)

export class CsvError extends Error {}

/** Parses CSV with quoted fields, escaped quotes and embedded newlines. The delimiter is detected among , ; and tab. */
export function parseCsv(text: string): { header: string[]; rows: { line: number; cells: string[] }[] } {
  if (Buffer.byteLength(text) > MAX_BYTES) throw new CsvError(`The file is larger than ${MAX_BYTES / 1024} KB`);
  const src = text.replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] ?? '';
  const delimiter = ([',', ';', '\t'] as const).map((d) => ({ d, n: firstLine.split(d).length })).sort((a, b) => b.n - a.n)[0].d;
  const records: { line: number; cells: string[] }[] = [];
  let cells: string[] = [];
  let cur = '';
  let inQuotes = false;
  let line = 1;
  let recordLine = 1;
  let any = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQuotes = false;
      } else {
        if (c === '\n') line++;
        cur += c;
      }
      continue;
    }
    if (c === '"' && cur === '') {
      inQuotes = true;
      any = true;
    } else if (c === delimiter) {
      cells.push(cur);
      cur = '';
      any = true;
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      if (any || cur !== '') {
        cells.push(cur);
        records.push({ line: recordLine, cells });
      }
      cells = [];
      cur = '';
      any = false;
      line++;
      recordLine = line;
    } else {
      cur += c;
      any = true;
    }
  }
  if (inQuotes) throw new CsvError('A quoted field is not closed');
  if (any || cur !== '') {
    cells.push(cur);
    records.push({ line: recordLine, cells });
  }
  if (!records.length) throw new CsvError('The file is empty');
  const header = records[0].cells.map((h) => h.trim());
  const rows = records.slice(1).filter((r) => r.cells.some((c) => c.trim() !== ''));
  if (rows.length > MAX_ROWS) throw new CsvError(`More than ${MAX_ROWS} rows; split the file`);
  return { header, rows };
}

// ------------------------------------------------------------------ import

export type RowStatus = 'OK' | 'IMPORTED' | 'DUPLICATE' | 'ERROR';
export interface RowResult {
  line: number;
  reference?: string;
  status: RowStatus;
  errors: string[];
  summary?: { checkIn: string; checkOut: string; nights: number; adults: number; total: number; guest: string };
}

const DATE_FORMATS: Record<string, RegExp> = {
  'YYYY-MM-DD': /^(\d{4})-(\d{2})-(\d{2})$/,
  'DD/MM/YYYY': /^(\d{2})\/(\d{2})\/(\d{4})$/,
  'MM/DD/YYYY': /^(\d{2})\/(\d{2})\/(\d{4})$/,
};
function toIsoDate(raw: string, format: string): string | null {
  const m = DATE_FORMATS[format]?.exec(raw.trim());
  if (!m) return null;
  const [y, mo, d] = format === 'YYYY-MM-DD' ? [m[1], m[2], m[3]] : format === 'DD/MM/YYYY' ? [m[3], m[2], m[1]] : [m[3], m[1], m[2]];
  const iso = `${y}-${mo}-${d}`;
  const dt = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(dt.getTime()) || dt.toISOString().slice(0, 10) !== iso ? null : iso;
}
function toMinor(raw: string): number | null {
  const s = raw.trim().replace(/^[₹$€£]\s*/, '').replace(/\s/g, '');
  const cleaned = /^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s) ? s.replace(/,/g, '') : s;
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  return Math.round(Number(cleaned) * 100);
}

class ColumnsDto {
  @ApiProperty({ example: 'Booking ref', description: 'Your own unique reference for the booking: it makes the import safe to repeat' }) @IsString() @Length(1, 100) reference!: string;
  @ApiProperty({ example: 'Arrival' }) @IsString() @Length(1, 100) checkIn!: string;
  @ApiProperty({ example: 'Departure' }) @IsString() @Length(1, 100) checkOut!: string;
  @ApiProperty({ example: 'Adults' }) @IsString() @Length(1, 100) adults!: string;
  @ApiProperty({ example: 'First name' }) @IsString() @Length(1, 100) guestFirstName!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 100) guestLastName?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 100) email?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 100) phone?: string;
  @ApiProperty({ example: 'Total', description: 'The price of the whole stay, in major units (rupees)' }) @IsString() @Length(1, 100) total!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 100) children?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 100) notes?: string;
}

class ImportDto {
  @ApiProperty({ description: 'The file contents (CSV, up to 1 MB / 1000 rows)' }) @IsString() @Length(1, MAX_BYTES) csv!: string;
  @ApiProperty() @IsUUID() roomTypeId!: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() ratePlanId?: string;
  @ApiProperty({ type: ColumnsDto, description: 'Which column holds what (by header name)' }) @ValidateNested() @Type(() => ColumnsDto) columns!: ColumnsDto;
  @ApiProperty({ enum: Object.keys(DATE_FORMATS) }) @IsIn(Object.keys(DATE_FORMATS)) dateFormat!: string;
  @ApiProperty({ default: true, description: 'true = only check and preview; nothing is written' }) @IsBoolean() dryRun!: boolean;
}

/**
 * Imports bookings from a spreadsheet. A dry run validates every row (dates, numbers, availability, duplicates) and writes nothing;
 * the real run books each valid row through the same reservation transaction as any other booking, so inventory can never be
 * oversold, and reports every row. Re-running the same file is safe: the reference column makes each booking idempotent.
 */
@Injectable()
export class CsvImportService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly reservations: ReservationService,
    private readonly access: PropertyAccessService,
    private readonly audit: AuditLogger,
  ) {}

  async run(user: AuthUser, meta: RequestMeta, ctx: PropertyAccessContext, dto: ImportDto) {
    if (!this.access.can(ctx, Permission.RATES_MANAGE)) throw new ForbiddenError('Importing bookings with their own prices needs rates:manage');
    const rt = await this.db.selectFrom('roomTypes').select(['id', 'name']).where('id', '=', dto.roomTypeId).where('propertyId', '=', ctx.propertyId).executeTakeFirst();
    if (!rt) throw new NotFoundError('Room type', dto.roomTypeId);
    if (dto.ratePlanId) {
      const rp = await this.db.selectFrom('ratePlans').select('id').where('id', '=', dto.ratePlanId).where('propertyId', '=', ctx.propertyId).executeTakeFirst();
      if (!rp) throw new NotFoundError('Rate plan', dto.ratePlanId);
    }
    let parsed;
    try {
      parsed = parseCsv(dto.csv);
    } catch (e) {
      throw new DomainValidationError((e as Error).message);
    }
    const index = new Map(parsed.header.map((h, i) => [h.toLowerCase(), i]));
    const col = (name: string | undefined, required: boolean): number | undefined => {
      if (!name) return undefined;
      const i = index.get(name.trim().toLowerCase());
      if (i === undefined && required) throw new DomainValidationError(`The file has no column named "${name}"`, { columns: parsed.header });
      return i;
    };
    const c = dto.columns;
    const ix = {
      reference: col(c.reference, true)!,
      checkIn: col(c.checkIn, true)!,
      checkOut: col(c.checkOut, true)!,
      adults: col(c.adults, true)!,
      first: col(c.guestFirstName, true)!,
      total: col(c.total, true)!,
      last: col(c.guestLastName, false),
      email: col(c.email, false),
      phone: col(c.phone, false),
      children: col(c.children, false),
      notes: col(c.notes, false),
    };

    const property = await this.db.selectFrom('properties').select(['timezone', 'currency', 'bookingHorizonDays']).where('id', '=', ctx.propertyId).executeTakeFirstOrThrow();
    const today = todayIn(property.timezone);
    const horizon = formatDateOnly(addDays(today, property.bookingHorizonDays));
    const todayStr = formatDateOnly(today);

    // availability simulation: what is left per night, reduced by the earlier rows of this same file
    const left = new Map<string, number>();
    const inv = await this.db.selectFrom('inventory').select(['date', 'available', 'stopSell']).where('propertyId', '=', ctx.propertyId).where('roomTypeId', '=', rt.id).where('date', '>=', todayStr as never).where('date', '<=', horizon as never).execute();
    for (const r of inv) left.set(r.date instanceof Date ? r.date.toISOString().slice(0, 10) : String(r.date).slice(0, 10), r.stopSell ? 0 : r.available);

    const seen = new Set<string>();
    const results: RowResult[] = [];
    for (const row of parsed.rows) {
      const get = (i: number | undefined) => (i === undefined ? '' : (row.cells[i] ?? '').trim());
      const errors: string[] = [];
      const reference = get(ix.reference);
      const res: RowResult = { line: row.line, reference: reference || undefined, status: 'OK', errors };
      if (!/^[A-Za-z0-9._:/-]{1,100}$/.test(reference)) errors.push('reference must be 1-100 characters of letters, digits and . _ : / -');
      else if (seen.has(reference)) errors.push('this reference appears earlier in the file');
      seen.add(reference);
      const ci = toIsoDate(get(ix.checkIn), dto.dateFormat);
      const co = toIsoDate(get(ix.checkOut), dto.dateFormat);
      if (!ci) errors.push(`check-in is not a valid ${dto.dateFormat} date`);
      if (!co) errors.push(`check-out is not a valid ${dto.dateFormat} date`);
      const nights = ci && co ? Math.round((Date.parse(co) - Date.parse(ci)) / 86_400_000) : 0;
      if (ci && co && (nights < 1 || nights > 90)) errors.push('the stay must be 1 to 90 nights');
      if (ci && ci < todayStr) errors.push('check-in is in the past');
      if (ci && ci > horizon) errors.push(`check-in is beyond the sellable horizon (${horizon})`);
      const adults = Number(get(ix.adults));
      if (!Number.isInteger(adults) || adults < 1 || adults > 100) errors.push('adults must be a whole number from 1');
      const children = ix.children === undefined || get(ix.children) === '' ? 0 : Number(get(ix.children));
      if (!Number.isInteger(children) || children < 0) errors.push('children must be a whole number');
      const first = get(ix.first);
      if (!first || first.length > 100) errors.push('guest first name is missing');
      const email = get(ix.email);
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push('email is not valid');
      const phone = get(ix.phone).replace(/[\s-]/g, '');
      if (phone && !/^\+[1-9]\d{6,14}$/.test(phone)) errors.push('phone must be in international format: + then the country code and number');
      const total = toMinor(get(ix.total));
      if (total === null) errors.push('total is not a valid amount');

      if (!errors.length && ci && co && total !== null) {
        const dates = Array.from({ length: nights }, (_, i) => formatDateOnly(addDays(new Date(`${ci}T00:00:00Z`) as never, i)));
        const dup = await this.db.selectFrom('reservations').select('id').where('propertyId', '=', ctx.propertyId).where('source', '=', CSV_SOURCE).where('externalScope', '=', ctx.propertyId).where('externalReservationId', '=', reference).executeTakeFirst();
        if (dup) res.status = 'DUPLICATE';
        else if (dates.some((d) => (left.get(d) ?? 0) < 1)) errors.push(`no room left on ${dates.find((d) => (left.get(d) ?? 0) < 1)}`);
        else for (const d of dates) left.set(d, (left.get(d) ?? 0) - 1);
        res.summary = { checkIn: ci, checkOut: co, nights, adults, total, guest: `${first} ${get(ix.last).slice(0, 1)}`.trim() };
        if (!errors.length && res.status === 'OK' && !dto.dryRun) {
          try {
            const base = Math.floor(total / nights);
            const rest = total - base * nights;
            const out = await this.reservations.createReservation({
              propertyId: ctx.propertyId,
              source: CSV_SOURCE,
              externalReservationId: reference,
              externalScope: ctx.propertyId,
              status: ReservationStatus.CONFIRMED,
              guest: { firstName: first, lastName: get(ix.last), email: email || undefined, phone: phone || undefined },
              checkIn: ci,
              checkOut: co,
              adults,
              children,
              rooms: [{ roomTypeId: rt.id, ratePlanId: dto.ratePlanId ?? null, quantity: 1, nightlyRates: Array.from({ length: nights }, (_, i) => base + (i < rest ? 1 : 0)) }],
              specialRequests: get(ix.notes).slice(0, 1000) || undefined,
              createdBy: user.userId,
              auditMetadata: { csvImport: true },
            });
            res.status = out.created ? 'IMPORTED' : 'DUPLICATE';
          } catch (e) {
            res.status = 'ERROR';
            errors.push(e instanceof DomainError ? e.message : 'could not be booked');
          }
        }
      }
      if (errors.length) res.status = 'ERROR';
      results.push(res);
    }
    const totals = {
      rows: results.length,
      ok: results.filter((r) => r.status === 'OK').length,
      imported: results.filter((r) => r.status === 'IMPORTED').length,
      duplicates: results.filter((r) => r.status === 'DUPLICATE').length,
      errors: results.filter((r) => r.status === 'ERROR').length,
    };
    await this.audit.log({ user, meta }, { action: dto.dryRun ? 'reservations.csv_preview' : 'reservations.csv_import', entityType: 'Property', entityId: ctx.propertyId, propertyId: ctx.propertyId, metadata: totals });
    return { dryRun: dto.dryRun, roomType: rt.name, totals, rows: results };
  }
}

@ApiTags('Reservations')
@Controller('properties/:propertyId/reservations/import')
export class CsvImportController {
  constructor(private readonly csv: CsvImportService) {}

  @Post()
  @HttpCode(200)
  @PropertyAccess(Permission.RESERVATIONS_MANAGE, { in: 'param', key: 'propertyId', entity: 'property' })
  @ApiOperation({ summary: 'Import bookings from a CSV file (dryRun=true previews every row and writes nothing)' })
  @ApiStandardErrors({ notFound: true })
  import(@CurrentUser() user: AuthUser, @ReqMeta() meta: RequestMeta, @PropertyCtx() ctx: PropertyAccessContext, @Param('propertyId', ParseUuidPipe) _propertyId: string, @Body() dto: ImportDto) {
    void _propertyId;
    return this.csv.run(user, meta, ctx, dto);
  }
}
