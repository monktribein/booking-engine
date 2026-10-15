import { PipeTransform } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { Types } from 'mongoose';
import { DomainValidationError } from '../database/errors';

export function toObjectId(value: string | Types.ObjectId, field = 'id'): Types.ObjectId {
  if (value instanceof Types.ObjectId) return value;
  if (typeof value !== 'string' || !/^[0-9a-fA-F]{24}$/.test(value)) {
    throw new DomainValidationError(`${field} must be a valid id`, { field });
  }
  return new Types.ObjectId(value);
}

/** Route-param pipe: '/reservations/:id' → ObjectId, or 400 VALIDATION_ERROR. */
export class ParseObjectIdPipe implements PipeTransform<string, Types.ObjectId> {
  transform(value: string): Types.ObjectId {
    return toObjectId(value);
  }
}

export function slugify(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70);
}

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface Page<T> {
  items: T[];
  page: number;
  limit: number;
  total: number;
}

export function pageParams(page = 1, limit = 20) {
  const p = Math.max(1, Math.floor(page));
  const l = Math.min(100, Math.max(1, Math.floor(limit)));
  return { page: p, limit: l, skip: (p - 1) * l };
}

/**
 * Defence in depth against NoSQL operator injection. DTO validation already
 * rejects objects where strings are expected. This also strips any key that
 * starts with "$" or contains "." from JSON bodies before anything reads them.
 * Query strings need no pass: Express 5's default "simple" parser never builds
 * nested objects (a[$gt]=1 stays a literal key), and query DTOs whitelist and
 * type every field.
 */
export function mongoSanitize(req: Request, _res: Response, next: NextFunction): void {
  const clean = (v: unknown, depth = 0): unknown => {
    if (depth > 10 || v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map((x) => clean(x, depth + 1));
    for (const key of Object.keys(v as object)) {
      if (key.startsWith('$') || key.includes('.')) delete (v as Record<string, unknown>)[key];
      else (v as Record<string, unknown>)[key] = clean((v as Record<string, unknown>)[key], depth + 1);
    }
    return v;
  };
  if (req.body) clean(req.body);
  next();
}
