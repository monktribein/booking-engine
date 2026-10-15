import { LoggerService } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

/**
 * Structured logging: one JSON object per line on stdout (the contract of every log platform), with redaction applied to
 * everything that is written, so a token or a password cannot reach the logs even if a message carries one by accident.
 */

const REDACTIONS: [RegExp, string | ((m: string) => string)][] = [
  [/\bTRV-[A-Z0-9]{6,}\b/g, 'TRV-***'], // booking codes identify a customer's stay
  [/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer ***'],
  [/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, '***jwt***'],
  [/(mongodb(?:\+srv)?:\/\/)[^@\s/]+@/gi, '$1***@'],
  [/(rediss?:\/\/)[^@\s/]*@/gi, '$1***@'],
  [/(smtps?:\/\/)[^@\s/]+@/gi, '$1***@'],
  [/("?(?:password|passwd|secret|token|authorization|api[_-]?key|refresh[_-]?token|razorpay_signature|signature)"?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}&]+)/gi, '$1"***"'],
  [/\b[A-Za-z0-9._%+-]{1,64}@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g, (m: string) => `${m[0]}***@${m.split('@')[1]}`],
  [/\+\d[\d\s-]{8,}\d/g, (m: string) => `${m.slice(0, 3)}***${m.slice(-2)}`],
];

export function redact(input: string): string {
  let out = input;
  for (const [re, to] of REDACTIONS) out = out.replace(re, to as string);
  return out;
}

const SENSITIVE_KEYS = /^(password|passwd|secret|token|authorization|cookie|apikey|api_key|refreshtoken|signature|razorpay_signature|email|phone|guest)$/i;

/** Redacts string values and masks sensitive keys in (a copy of) a structured log payload. */
export function redactValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redact(value);
  if (value === null || typeof value !== 'object' || depth > 4) return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redactValue(v, depth + 1));
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, SENSITIVE_KEYS.test(k) ? '***' : redactValue(v, depth + 1)]));
}

type Level = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export class JsonLogger implements LoggerService {
  constructor(private readonly service = 'tirvona-api') {}

  private write(level: Level, message: unknown, optional: unknown[]): void {
    // Nest passes the context (class name) as the last string argument; error() may pass a stack before it.
    const params = [...optional];
    const context = typeof params[params.length - 1] === 'string' ? (params.pop() as string) : undefined;
    const trace = level === 'error' && typeof params[0] === 'string' ? redact(params[0]).slice(0, 4000) : undefined;
    const base = { level, ts: new Date().toISOString(), service: this.service, ...(context ? { context } : {}) };
    const body = message !== null && typeof message === 'object' && !(message instanceof Error) ? (redactValue(message) as Record<string, unknown>) : { message: redact(message instanceof Error ? message.stack ?? message.message : String(message)).slice(0, 4000) };
    const line = JSON.stringify({ ...base, ...body, ...(trace ? { trace } : {}) });
    (level === 'error' || level === 'fatal' ? process.stderr : process.stdout).write(line + '\n');
  }

  log(message: unknown, ...optional: unknown[]) {
    this.write('info', message, optional);
  }
  error(message: unknown, ...optional: unknown[]) {
    this.write('error', message, optional);
  }
  warn(message: unknown, ...optional: unknown[]) {
    this.write('warn', message, optional);
  }
  debug(message: unknown, ...optional: unknown[]) {
    if (process.env.LOG_LEVEL === 'debug') this.write('debug', message, optional);
  }
  verbose(message: unknown, ...optional: unknown[]) {
    if (process.env.LOG_LEVEL === 'debug') this.write('debug', message, optional);
  }
  fatal(message: unknown, ...optional: unknown[]) {
    this.write('fatal', message, optional);
  }
}

/** True when JSON logs are wanted: LOG_FORMAT=json, or production unless LOG_FORMAT=text. */
export function useJsonLogs(env = process.env): boolean {
  return env.LOG_FORMAT === 'json' || (env.NODE_ENV === 'production' && env.LOG_FORMAT !== 'text');
}

const REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/;

/**
 * Request id + access log. The id is taken from an incoming X-Request-Id when it looks sane (so a load balancer's id
 * is kept), otherwise generated, and always echoed in the response. The access line contains the ROUTE PATTERN
 * (`/public/reservations/:code`), never the raw URL: no query strings, booking codes, e-mails or tokens.
 */
export function requestLogger(logger: JsonLogger) {
  return (req: Request, res: Response, next: NextFunction) => {
    const incoming = req.header('x-request-id');
    const id = incoming && REQUEST_ID.test(incoming) ? incoming : randomUUID();
    (req as Request & { id?: string }).id = id;
    res.setHeader('X-Request-Id', id);
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const status = res.statusCode;
      const route = (req.route?.path as string | undefined) ?? (status === 404 ? 'unmatched' : 'unknown');
      if (route === '/health' && status < 400) return; // probes every few seconds would drown the log
      const ms = Number((process.hrtime.bigint() - started) / 1_000_000n);
      const entry = { event: 'http_request', requestId: id, method: req.method, route: `${req.baseUrl ?? ''}${route === 'unmatched' || route === 'unknown' ? '' : route}` || route, status, ms };
      if (status >= 500) logger.error(entry);
      else if (status >= 400) logger.warn(entry);
      else logger.log(entry);
    });
    next();
  };
}
