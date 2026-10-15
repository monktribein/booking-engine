import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';

/** Address ranges a customer-supplied webhook URL must never reach (SSRF): loopback, private, link-local, cloud metadata, CGNAT, multicast. */
const BLOCKED = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  BLOCKED.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  BLOCKED.addSubnet(net, prefix, 'ipv6');
}

export function isBlockedAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address); // IPv4-mapped IPv6
  const ip = mapped ? mapped[1] : address;
  const family = isIP(ip);
  if (!family) return true; // not an IP at all: refuse
  return BLOCKED.check(ip, family === 4 ? 'ipv4' : 'ipv6');
}

export class UnsafeWebhookTargetError extends Error {}

/** Static checks done when an endpoint is registered (no DNS, no network). */
export function validateWebhookUrl(raw: string, allowPrivate: boolean): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new UnsafeWebhookTargetError('url is not a valid URL');
  }
  if (u.protocol !== 'https:' && !(allowPrivate && u.protocol === 'http:')) throw new UnsafeWebhookTargetError('url must use https');
  if (u.username || u.password) throw new UnsafeWebhookTargetError('url must not contain credentials');
  if (!allowPrivate) {
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) throw new UnsafeWebhookTargetError('url must not target a local host');
    if (isIP(host) && isBlockedAddress(host)) throw new UnsafeWebhookTargetError('url must not target a private or loopback address');
  }
  return u;
}

export interface PostResult {
  status: number;
}

/**
 * POSTs a body and returns the status. The destination address is validated at CONNECT time inside the
 * socket's DNS lookup, so a hostname that resolves to a private address (or is re-pointed after validation)
 * cannot be reached. Redirects are never followed. The response body is discarded.
 */
export function postWebhook(url: URL, headers: Record<string, string>, body: string, opts: { timeoutMs: number; allowPrivate: boolean }): Promise<PostResult> {
  const lib = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(
      url,
      {
        method: 'POST',
        headers: { ...headers, 'Content-Length': String(Buffer.byteLength(body)) },
        timeout: opts.timeoutMs,
        lookup: (hostname, options, cb) => {
          dns.lookup(hostname, options, (err, address, family) => {
            if (err) return cb(err, address as never, family as never);
            const list = Array.isArray(address) ? (address as unknown as { address: string; family: number }[]) : [{ address: address as string, family: family as number }];
            if (!opts.allowPrivate && list.some((a) => isBlockedAddress(a.address))) {
              return cb(new UnsafeWebhookTargetError(`${hostname} resolves to a private address`) as never, '' as never, 0 as never);
            }
            return Array.isArray(address) ? cb(null, address as never, family as never) : cb(null, address, family);
          });
        },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode ?? 0 }));
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error(`timed out after ${opts.timeoutMs} ms`)));
    req.on('error', reject);
    req.end(body);
  });
}
