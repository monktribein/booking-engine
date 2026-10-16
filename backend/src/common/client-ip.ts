import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Request } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

export const BFF_SECRET_HEADER = 'x-tirvona-bff-secret';
export const BFF_CLIENT_IP_HEADER = 'x-tirvona-client-ip';

const digest = (s: string) => createHmac('sha256', 'tirvona-bff').update(s).digest();

/**
 * The address of the person using the app.
 *
 * Normally that is `req.ip`. When the web app signs users in through its own server (so the refresh token can live in an HttpOnly
 * cookie), every login reaches this API from that server's address. The web server therefore forwards the real client address in
 * a header, and proves it is the web server by also sending the shared secret `BFF_SHARED_SECRET`. Without a valid secret the
 * header is ignored, so nobody else can choose the address used for rate limiting or audit logs.
 */
export function clientIp(req: Pick<Request, 'ip' | 'get'>): string | undefined {
  const secret = process.env.BFF_SHARED_SECRET;
  const presented = req.get(BFF_SECRET_HEADER);
  const forwarded = req.get(BFF_CLIENT_IP_HEADER)?.trim();
  if (secret && presented && forwarded && isIP(forwarded) && timingSafeEqual(digest(secret), digest(presented))) return forwarded;
  return req.ip;
}

/** Per-client rate limiting that understands the web app's forwarded client address (see clientIp). */
@Injectable()
export class ClientIpThrottlerGuard extends ThrottlerGuard {
  protected override async getTracker(req: Record<string, any>): Promise<string> {
    return clientIp(req as Request) ?? 'unknown';
  }
}
