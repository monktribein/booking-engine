import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { isBlockedAddress, UnsafeWebhookTargetError } from '../../public-api/safe-http';

/**
 * The only way provider integrations reach the network. Every request is checked twice:
 *   1. before sending: https only, host must be one of the provider's exact allowed hosts, no credentials in the URL, default port,
 *      allowed method, clean headers, bounded body;
 *   2. while connecting: the address the host resolves to is validated inside the socket's DNS lookup, so a name that points at a
 *      private/loopback/link-local/metadata address (or is re-pointed after validation) cannot be reached.
 * Redirects are never followed. The response is read with a hard size cap and a total deadline.
 */

export class HttpSafetyError extends Error {
  constructor(
    readonly code: 'URL_REJECTED' | 'HOST_NOT_ALLOWED' | 'METHOD_NOT_ALLOWED' | 'HEADER_REJECTED' | 'REQUEST_TOO_LARGE' | 'RESPONSE_TOO_LARGE' | 'REDIRECT_REFUSED' | 'TIMEOUT' | 'NETWORK',
    message: string,
  ) {
    super(message);
  }
}

export interface SecureRequest {
  url: URL;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH';
  headers: Record<string, string>;
  body?: string;
  allowedHosts: ReadonlySet<string>;
  timeoutMs: number;
  maxRequestBytes: number;
  maxResponseBytes: number;
  /** Local fake servers in tests/dev only (WEBHOOK_ALLOW_PRIVATE_TARGETS, refused in production). */
  allowPrivate?: boolean;
}

export interface SecureResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

const HEADER_NAME = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;
const FORBIDDEN_HEADERS = new Set(['host', 'content-length', 'transfer-encoding', 'connection', 'upgrade', 'te', 'trailer', 'expect', 'proxy-authorization']);

export function assertSafeRequest(r: SecureRequest): void {
  const u = r.url;
  const insecureOk = r.allowPrivate === true;
  if (u.protocol !== 'https:' && !(insecureOk && u.protocol === 'http:')) throw new HttpSafetyError('URL_REJECTED', 'only https URLs are allowed');
  if (u.username || u.password) throw new HttpSafetyError('URL_REJECTED', 'URLs must not contain credentials');
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!r.allowedHosts.has(host)) throw new HttpSafetyError('HOST_NOT_ALLOWED', `host ${host} is not in the provider's allowed hosts`);
  if (!insecureOk) {
    if (u.port && u.port !== '443') throw new HttpSafetyError('URL_REJECTED', 'only the default https port is allowed');
    if (isIP(host)) throw new HttpSafetyError('URL_REJECTED', 'IP address hosts are not allowed');
  }
  if (!['GET', 'POST', 'PUT', 'PATCH'].includes(r.method)) throw new HttpSafetyError('METHOD_NOT_ALLOWED', `method ${r.method} is not allowed`);
  for (const [k, v] of Object.entries(r.headers)) {
    if (!HEADER_NAME.test(k) || FORBIDDEN_HEADERS.has(k.toLowerCase())) throw new HttpSafetyError('HEADER_REJECTED', `header ${k} is not allowed`);
    if (/[\r\n\u0000]/.test(v) || v.length > 4096) throw new HttpSafetyError('HEADER_REJECTED', `header ${k} has an invalid value`);
  }
  if (r.body !== undefined && Buffer.byteLength(r.body) > r.maxRequestBytes) throw new HttpSafetyError('REQUEST_TOO_LARGE', 'request body is too large');
}

export function secureRequest(r: SecureRequest): Promise<SecureResponse> {
  try {
    assertSafeRequest(r);
  } catch (e) {
    return Promise.reject(e);
  }
  const lib = r.url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      fn();
    };
    const headers: Record<string, string> = { Accept: 'application/json', 'Accept-Encoding': 'identity', 'User-Agent': 'Tirvona-ChannelManager/1', ...r.headers };
    if (r.body !== undefined) {
      headers['Content-Type'] = headers['Content-Type'] ?? 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(r.body));
    }
    const req = lib.request(
      r.url,
      {
        method: r.method,
        headers,
        timeout: r.timeoutMs,
        lookup: (hostname, options, cb) => {
          dns.lookup(hostname, options, (err, address, family) => {
            if (err) return cb(err, address as never, family as never);
            const list = Array.isArray(address) ? (address as unknown as { address: string; family: number }[]) : [{ address: address as string, family: family as number }];
            if (!r.allowPrivate && list.some((a) => isBlockedAddress(a.address))) {
              return cb(new UnsafeWebhookTargetError(`${hostname} resolves to a private address`) as never, '' as never, 0 as never);
            }
            return Array.isArray(address) ? cb(null, address as never, family as never) : cb(null, address, family);
          });
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          res.resume();
          return done(() => reject(new HttpSafetyError('REDIRECT_REFUSED', `the server answered ${status}; redirects are not followed`)));
        }
        const declared = Number(res.headers['content-length']);
        if (Number.isFinite(declared) && declared > r.maxResponseBytes) {
          res.destroy();
          return done(() => reject(new HttpSafetyError('RESPONSE_TOO_LARGE', 'response is too large')));
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > r.maxResponseBytes) {
            res.destroy();
            return done(() => reject(new HttpSafetyError('RESPONSE_TOO_LARGE', 'response is too large')));
          }
          chunks.push(c);
        });
        res.on('end', () => {
          const out: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) if (typeof v === 'string') out[k.toLowerCase()] = v;
          done(() => resolve({ status, headers: out, body: Buffer.concat(chunks).toString('utf8') }));
        });
        res.on('error', (e) => done(() => reject(new HttpSafetyError('NETWORK', e.message))));
      },
    );
    // Total deadline (the socket timeout above only covers inactivity, so a slow-drip response cannot hold a worker).
    const deadline = setTimeout(() => {
      req.destroy();
      done(() => reject(new HttpSafetyError('TIMEOUT', `timed out after ${r.timeoutMs} ms`)));
    }, r.timeoutMs);
    req.on('timeout', () => {
      req.destroy();
      done(() => reject(new HttpSafetyError('TIMEOUT', `timed out after ${r.timeoutMs} ms`)));
    });
    req.on('error', (e) => done(() => reject(e instanceof UnsafeWebhookTargetError ? new HttpSafetyError('URL_REJECTED', e.message) : new HttpSafetyError('NETWORK', e.message))));
    if (r.body !== undefined) req.write(r.body);
    req.end();
  });
}
