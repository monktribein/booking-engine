import { CanActivate, ExecutionContext, HttpException, Injectable, SetMetadata, createParamDecorator } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { InjectThrottlerStorage, ThrottlerStorage } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import type { AppConfig } from '../../config/configuration';
import type { ApiScope } from '../../database/enums';
import { ForbiddenError, UnauthorizedError } from '../../database/errors';
import { ApiKeyService, ApiPrincipal } from './api-key.service';
import { ApiUsageService } from './api-usage.service';

export const API_SCOPES_KEY = 'tirvona:apiScopes';
/** Scopes an API key must hold (all of them) to call the route. */
export const RequireScopes = (...scopes: ApiScope[]) => SetMetadata(API_SCOPES_KEY, scopes);

type ApiRequest = Request & { apiKey?: ApiPrincipal };

/** The principal proven by ApiKeyGuard. */
export const CurrentApiKey = createParamDecorator((_: unknown, ctx: ExecutionContext): ApiPrincipal => ctx.switchToHttp().getRequest<ApiRequest>().apiKey as ApiPrincipal);

/**
 * Authenticates public-API requests: `Authorization: Bearer tvk_...` (or `X-API-Key`),
 * checks scopes, then applies a per-key rate limit (so one client cannot exhaust another's budget,
 * and a leaked key cannot be used to burn the shared per-IP budget of the dashboard).
 * Routes carrying this guard are @Public() for the JWT guard: they never accept user sessions.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    private readonly keys: ApiKeyService,
    private readonly usage: ApiUsageService,
    private readonly reflector: Reflector,
    @InjectThrottlerStorage() private readonly storage: ThrottlerStorage,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const http = ctx.switchToHttp();
    const req = http.getRequest<ApiRequest>();
    const res = http.getResponse<Response>();
    res.setHeader('X-Tirvona-Api-Version', 'v1');

    const header = req.get('authorization') ?? '';
    const [scheme, token] = header.split(' ');
    const raw = scheme === 'Bearer' && token ? token : req.get('x-api-key');
    if (!raw) throw new UnauthorizedError('Missing API key. Send "Authorization: Bearer tvk_..."', 'API_KEY_MISSING');

    const principal = await this.keys.authenticate(raw.trim(), req.ip);
    req.apiKey = principal;
    // Count the request when it finishes, with its final status (scope errors and rate limits included).
    res.once('finish', () => this.usage.record(principal.apiKeyId, res.statusCode));

    const required = this.reflector.getAllAndOverride<ApiScope[] | undefined>(API_SCOPES_KEY, [ctx.getHandler(), ctx.getClass()]) ?? [];
    const missing = required.filter((s) => !principal.scopes.includes(s));
    if (missing.length) throw new ForbiddenError(`API key lacks required scope: ${missing.join(', ')}`, 'API_SCOPE_MISSING');

    const { keyRateLimit, keyRateTtlMs } = this.config.get('publicApi', { infer: true });
    const rec = await this.storage.increment(`apikey:${String(principal.apiKeyId)}`, keyRateTtlMs, keyRateLimit, keyRateTtlMs, 'apikey');
    res.setHeader('RateLimit-Limit', String(keyRateLimit));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, keyRateLimit - rec.totalHits)));
    res.setHeader('RateLimit-Reset', String(rec.timeToExpire));
    if (rec.isBlocked) {
      res.setHeader('Retry-After', String(rec.timeToBlockExpire || rec.timeToExpire));
      throw new HttpException({ code: 'RATE_LIMITED', message: 'API key rate limit exceeded' }, 429);
    }
    return true;
  }
}
