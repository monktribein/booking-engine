/**
 * Provider definitions: the declarative description of a REST/JSON integration. A definition is DATA. It can name hosts,
 * paths, headers, field paths and whitelisted transforms, and nothing else: there is no scripting, no expression language
 * and no way to reach code. `validateDefinition` is the only gate between a stored definition and the engine, and it rejects
 * everything it does not understand (unknown keys included).
 */

export const SCHEMA_VERSION = 1;
export const MAX_DEFINITION_BYTES = 64 * 1024;

export const OPERATIONS = [
  'healthCheck',
  'listListings',
  'listRoomTypes',
  'listRatePlans',
  'listReservations',
  'getReservation',
  'pushAvailability',
  'pushRates',
  'pushRestrictions',
  'ackReservation',
] as const;
export type OperationName = (typeof OPERATIONS)[number];

export const CAPABILITIES = ['listings', 'roomTypes', 'ratePlans', 'pullReservations', 'getReservation', 'pushAvailability', 'pushRates', 'pushRestrictions', 'ackReservation', 'webhooks', 'polling'] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** Which capability an operation needs. `healthCheck` needs none. */
export const OPERATION_CAPABILITY: Record<OperationName, Capability | null> = {
  healthCheck: null,
  listListings: 'listings',
  listRoomTypes: 'roomTypes',
  listRatePlans: 'ratePlans',
  listReservations: 'pullReservations',
  getReservation: 'getReservation',
  pushAvailability: 'pushAvailability',
  pushRates: 'pushRates',
  pushRestrictions: 'pushRestrictions',
  ackReservation: 'ackReservation',
};

/** Placeholders each operation may use in paths, queries, headers and bodies. Anything else fails validation. */
export const PLACEHOLDERS: Record<OperationName, readonly string[]> = {
  healthCheck: ['environment'],
  listListings: ['cursor', 'page', 'pageSize', 'externalAccountId'],
  listRoomTypes: ['externalListingId', 'cursor', 'page', 'pageSize', 'externalAccountId'],
  listRatePlans: ['externalListingId', 'cursor', 'page', 'pageSize', 'externalAccountId'],
  listReservations: ['since', 'sinceDate', 'cursor', 'page', 'pageSize', 'externalAccountId', 'externalListingId'],
  getReservation: ['externalReservationId', 'externalAccountId'],
  pushAvailability: ['externalListingId', 'externalRoomId', 'from', 'to', 'externalAccountId'],
  pushRates: ['externalListingId', 'externalRoomId', 'externalRatePlanId', 'from', 'to', 'externalAccountId'],
  pushRestrictions: ['externalListingId', 'externalRoomId', 'from', 'to', 'externalAccountId'],
  ackReservation: ['externalReservationId', 'externalAccountId'],
};

/** Fields available as `{item.<name>}` inside an `$each` body of a push operation. */
export const ITEM_FIELDS: Partial<Record<OperationName, readonly string[]>> = {
  pushAvailability: ['externalListingId', 'externalRoomId', 'date', 'available', 'stopSell'],
  pushRates: ['externalListingId', 'externalRoomId', 'externalRatePlanId', 'date', 'price', 'currency'],
  pushRestrictions: ['externalListingId', 'externalRoomId', 'date', 'minimumStay', 'maximumStay', 'closedToArrival', 'closedToDeparture', 'closed'],
};

export const TRANSFORMS = ['minorToMajor', 'majorToMinor', 'upper', 'lower', 'int', 'string', 'dateCompact', 'boolInt'] as const;
export type TransformName = (typeof TRANSFORMS)[number];

export type AuthSpec =
  | { type: 'NONE' }
  | { type: 'API_KEY_HEADER'; header: string }
  | { type: 'API_KEY_QUERY'; param: string }
  | { type: 'BEARER' }
  | { type: 'BASIC' };

export interface RequestSigningSpec {
  algorithm: 'HMAC_SHA256';
  header: string;
  /** What is signed: the raw body, or `<timestamp>.<body>` (the timestamp is sent in `timestampHeader`). */
  payload: 'BODY' | 'TIMESTAMP.BODY';
  timestampHeader?: string;
  encoding: 'hex' | 'base64';
}

export interface PaginationSpec {
  type: 'NONE' | 'CURSOR' | 'PAGE' | 'OFFSET';
  /** Query parameter that carries the cursor / page number / offset. */
  param?: string;
  sizeParam?: string;
  pageSize?: number;
  /** Where the next cursor is found in a response (CURSOR). A missing/empty value ends paging. */
  nextPath?: string;
  /** Where the total number of items is (PAGE/OFFSET); optional. An empty page always ends paging. */
  maxPages?: number;
  firstPage?: number;
}

export type BodyTemplate = string | number | boolean | null | BodyTemplate[] | { [k: string]: BodyTemplate };

export interface OperationSpec {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH';
  path: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: BodyTemplate;
  /** Reads: where the list of items is in the response (default `$`, which must then be an array). */
  items?: string;
  /** Per-field paths relative to each item; see the mapping section of the guide. */
  fields?: Record<string, FieldSpec>;
  pagination?: PaginationSpec;
  /** Push operations: at most this many updates per request (the engine splits larger batches). */
  batchSize?: number;
  /** Sent as this header on writes so a retried request is not applied twice, when the provider supports it. */
  idempotencyHeader?: string;
  /** For pushes: response field with the number of accepted / rejected updates (optional). */
  acceptedPath?: string;
  rejectedPath?: string;
}

/** A field is a JSONPath-subset string, or a path with a transform and an enum map. */
export type FieldSpec = string | { path: string; transform?: TransformName; map?: Record<string, string>; default?: string | number | boolean | null; unit?: 'MINOR' | 'MAJOR' };

export interface ReservationMapping {
  statusPath: string;
  /** provider status -> RESERVATION_CREATED | RESERVATION_MODIFIED | RESERVATION_CANCELLED. Unmapped statuses are skipped and reported. */
  statusMap: Record<string, 'RESERVATION_CREATED' | 'RESERVATION_MODIFIED' | 'RESERVATION_CANCELLED'>;
  /** How the price is given: one total for the stay, or one amount per night. */
  pricing: { mode: 'TOTAL' | 'NIGHTLY'; path: string; unit: 'MINOR' | 'MAJOR' };
  dateFormat: 'YYYY-MM-DD' | 'ISO_DATETIME';
  /**
   * OPTIONAL operator declaration of who collects the guest's money for EVERY booking of this provider. Omit it when the provider's
   * contract does not say: bookings are then stored as UNKNOWN. A declaration is shown as "declared by configuration", never as a
   * fact reported by the provider.
   */
  paymentCollection?: 'CHANNEL' | 'PROPERTY';
  /** LEGACY (definitions saved before payment visibility): true = CHANNEL, false = PROPERTY. Read as an operator declaration. */
  paymentCollectedByChannel?: boolean;
  /** OPTIONAL paths to payment data the provider reports PER BOOKING. A path that finds nothing leaves the field unreported. */
  paymentFields?: PaymentFieldsMapping;
}

export interface PaymentFieldsMapping {
  /** Provider's payment status word, stored verbatim. statusMap (provider word to a normalised status) gives its reading; a word that is not listed stays raw-only. */
  statusPath?: string;
  statusMap?: Record<string, 'UNPAID' | 'PAID' | 'PARTIALLY_PAID' | 'REFUNDED' | 'PARTIALLY_REFUNDED' | 'FAILED'>;
  payoutStatusPath?: string;
  payoutStatusMap?: Record<string, 'PENDING' | 'COMPLETED' | 'FAILED'>;
  payoutDatePath?: string;
  commissionPath?: string;
  netAmountPath?: string;
  /** Unit of commission and net amount. Required when either path is set. */
  amountUnit?: 'MINOR' | 'MAJOR';
}

export interface WebhookSpec {
  signature: {
    scheme: 'HMAC_SHA256';
    header: string;
    /** `hex`, `base64`, or `t=,v1=` style (`t=<unix>,v1=<hex>`). */
    format: 'hex' | 'base64' | 'stripe';
    signedPayload: 'RAW_BODY' | 'TIMESTAMP.RAW_BODY';
    /** For TIMESTAMP.RAW_BODY with `hex`/`base64`: header carrying the unix timestamp. */
    timestampHeader?: string;
    toleranceSeconds?: number;
  };
  eventIdPath: string;
  eventTypePath: string;
  /** provider event type -> kind. Events not listed are stored as IGNORED. */
  typeMap: Record<string, 'RESERVATION_CREATED' | 'RESERVATION_MODIFIED' | 'RESERVATION_CANCELLED'>;
  /** Where the reservation object is in the webhook body. */
  reservationPath: string;
}

export interface ProviderDefinition {
  schemaVersion: 1;
  protocol: 'REST_JSON';
  environments: { production: { baseUrl: string }; sandbox?: { baseUrl: string } };
  allowedHosts: string[];
  auth: AuthSpec;
  signing?: RequestSigningSpec;
  capabilities: Partial<Record<Capability, boolean>>;
  operations: Partial<Record<OperationName, OperationSpec>>;
  reservationMapping?: ReservationMapping;
  webhook?: WebhookSpec;
  rateLimit?: { requestsPerSecond: number };
  retry?: { maxAttempts: number; baseDelayMs: number; maxDelayMs: number; retryOnStatus: number[] };
  limits?: { timeoutMs: number; maxRequestBytes: number; maxResponseBytes: number };
  /** Default polling interval offered to new connections, seconds. */
  defaultPollIntervalSeconds?: number;
  documentationUrl?: string;
}

// ------------------------------------------------------------------ platform ceilings (a definition can only lower them)

export const PLATFORM_LIMITS = { timeoutMs: 30_000, maxRequestBytes: 1024 * 1024, maxResponseBytes: 5 * 1024 * 1024, maxPages: 100, maxAttempts: 8, requestsPerSecond: 50, batchSize: 1000 } as const;
export const DEFAULT_LIMITS = { timeoutMs: 10_000, maxRequestBytes: 256 * 1024, maxResponseBytes: 2 * 1024 * 1024 } as const;
export const DEFAULT_RETRY = { maxAttempts: 4, baseDelayMs: 500, maxDelayMs: 15_000, retryOnStatus: [408, 425, 429, 500, 502, 503, 504] } as const;

// ------------------------------------------------------------------ validation

export interface ValidationIssue {
  path: string;
  message: string;
}
export interface ValidationResult {
  ok: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  definition?: ProviderDefinition;
}

export interface ValidateOptions {
  /** Test/dev only: permits http:// and localhost/private base URLs (a local fake server). Never in production. */
  allowInsecureHosts?: boolean;
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const HEADER_NAME = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;
const HARD_DENY = new Set(['host', 'content-length', 'transfer-encoding', 'connection', 'cookie', 'set-cookie', 'upgrade', 'te', 'trailer', 'expect', 'proxy-authorization', 'authorization', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip']);
/** Headers the engine itself controls; a definition may not set them on an operation. */
const OP_HEADER_DENY = new Set([...HARD_DENY, 'content-type', 'accept', 'user-agent', 'content-encoding']);
const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9_.]*)(?:\|([A-Za-z]+))?\}/g;
const PATH_SEGMENT_PLACEHOLDERS = new Set(['externalListingId', 'externalRoomId', 'externalRatePlanId', 'externalReservationId', 'externalAccountId']);

/** Parses `{name}` / `{name|transform}` placeholders of a template string. */
export function parsePlaceholders(template: string): { name: string; transform?: string; raw: string }[] {
  return [...template.matchAll(PLACEHOLDER)].map((m) => ({ raw: m[0], name: m[1], transform: m[2] }));
}

export function validateDefinition(input: unknown, opts: ValidateOptions = {}): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const err = (path: string, message: string) => errors.push({ path, message });
  const warn = (path: string, message: string) => warnings.push({ path, message });

  if (!isPlainObject(input)) {
    return { ok: false, errors: [{ path: '$', message: 'definition must be an object' }], warnings };
  }
  if (Buffer.byteLength(JSON.stringify(input)) > MAX_DEFINITION_BYTES) err('$', `definition exceeds ${MAX_DEFINITION_BYTES} bytes`);
  rejectForbiddenKeys(input, '$', err);

  const d = input as Record<string, unknown>;
  onlyKeys(d, ['schemaVersion', 'protocol', 'environments', 'allowedHosts', 'auth', 'signing', 'capabilities', 'operations', 'reservationMapping', 'webhook', 'rateLimit', 'retry', 'limits', 'defaultPollIntervalSeconds', 'documentationUrl'], '$', err);
  if (d.schemaVersion !== SCHEMA_VERSION) err('schemaVersion', `must be ${SCHEMA_VERSION}`);
  if (d.protocol !== 'REST_JSON') err('protocol', 'only REST_JSON definitions are supported (other protocols use dedicated adapters)');

  // hosts ---------------------------------------------------------------------------------------------------------
  const hosts = Array.isArray(d.allowedHosts) ? (d.allowedHosts as unknown[]) : null;
  if (!hosts || hosts.length < 1 || hosts.length > 10) err('allowedHosts', 'must list 1 to 10 exact host names');
  const hostSet = new Set<string>();
  for (const [i, h] of (hosts ?? []).entries()) {
    if (typeof h !== 'string') {
      err(`allowedHosts[${i}]`, 'must be a string');
      continue;
    }
    const ok = HOSTNAME.test(h) || (opts.allowInsecureHosts === true && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(h));
    if (!ok) err(`allowedHosts[${i}]`, 'must be an exact DNS host name (no wildcard, no IP address, no port, no scheme)');
    else if (!opts.allowInsecureHosts && (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal'))) err(`allowedHosts[${i}]`, 'local host names are not allowed');
    else hostSet.add(h);
  }

  const env = d.environments;
  if (!isPlainObject(env)) err('environments', 'required');
  else {
    onlyKeys(env, ['production', 'sandbox'], 'environments', err);
    for (const name of ['production', 'sandbox'] as const) {
      const e = (env as Record<string, unknown>)[name];
      if (e === undefined) {
        if (name === 'production') err('environments.production', 'required');
        continue;
      }
      if (!isPlainObject(e)) {
        err(`environments.${name}`, 'must be an object');
        continue;
      }
      onlyKeys(e, ['baseUrl'], `environments.${name}`, err);
      checkBaseUrl(e.baseUrl, `environments.${name}.baseUrl`, hostSet, opts, err);
    }
  }

  // auth ----------------------------------------------------------------------------------------------------------
  const auth = d.auth;
  if (!isPlainObject(auth)) err('auth', 'required');
  else {
    const t = auth.type;
    if (t === 'NONE' || t === 'BEARER' || t === 'BASIC') onlyKeys(auth, ['type'], 'auth', err);
    else if (t === 'API_KEY_HEADER') {
      onlyKeys(auth, ['type', 'header'], 'auth', err);
      checkHeaderName(auth.header, 'auth.header', err, true);
    } else if (t === 'API_KEY_QUERY') {
      onlyKeys(auth, ['type', 'param'], 'auth', err);
      if (typeof auth.param !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(auth.param)) err('auth.param', 'must be a simple parameter name');
      else warn('auth.param', 'API keys in the query string can leak into proxies and logs; prefer a header if the provider allows it (the engine redacts it everywhere)');
    } else err('auth.type', 'must be one of NONE, API_KEY_HEADER, API_KEY_QUERY, BEARER, BASIC (OAuth flows need a dedicated adapter)');
  }
  if (d.signing !== undefined) {
    const s = d.signing;
    if (!isPlainObject(s)) err('signing', 'must be an object');
    else {
      onlyKeys(s, ['algorithm', 'header', 'payload', 'timestampHeader', 'encoding'], 'signing', err);
      if (s.algorithm !== 'HMAC_SHA256') err('signing.algorithm', 'must be HMAC_SHA256');
      checkHeaderName(s.header, 'signing.header', err, true);
      if (s.payload !== 'BODY' && s.payload !== 'TIMESTAMP.BODY') err('signing.payload', 'must be BODY or TIMESTAMP.BODY');
      if (s.encoding !== 'hex' && s.encoding !== 'base64') err('signing.encoding', 'must be hex or base64');
      if (s.payload === 'TIMESTAMP.BODY') checkHeaderName(s.timestampHeader, 'signing.timestampHeader', err, true);
    }
  }

  // capabilities / operations -------------------------------------------------------------------------------------
  const caps = d.capabilities;
  if (!isPlainObject(caps)) err('capabilities', 'required');
  else {
    for (const [k, v] of Object.entries(caps)) {
      if (!(CAPABILITIES as readonly string[]).includes(k)) err(`capabilities.${k}`, 'unknown capability');
      else if (typeof v !== 'boolean') err(`capabilities.${k}`, 'must be true or false');
    }
  }
  const ops = d.operations;
  if (!isPlainObject(ops)) err('operations', 'required');
  else {
    for (const [name, spec] of Object.entries(ops)) {
      if (!(OPERATIONS as readonly string[]).includes(name)) {
        err(`operations.${name}`, 'unknown operation');
        continue;
      }
      checkOperation(name as OperationName, spec, `operations.${name}`, hostSet, err, warn);
    }
    if (isPlainObject(caps)) {
      for (const op of OPERATIONS) {
        const cap = OPERATION_CAPABILITY[op];
        if (!cap) continue;
        const declared = (caps as Record<string, unknown>)[cap] === true;
        const has = (ops as Record<string, unknown>)[op] !== undefined;
        if (declared && !has) err(`capabilities.${cap}`, `declared but operations.${op} is not defined`);
        if (!declared && has) warn(`operations.${op}`, `defined but capabilities.${cap} is not true, so it can never be called`);
      }
    }
    if ((ops as Record<string, unknown>).healthCheck === undefined) err('operations.healthCheck', 'a read-only health check is required: it is how a connection is verified before it is marked connected');
  }

  // reservation mapping / webhook ---------------------------------------------------------------------------------
  const needsMapping = isPlainObject(caps) && (caps.pullReservations === true || caps.getReservation === true || caps.webhooks === true);
  if (d.reservationMapping !== undefined) checkReservationMapping(d.reservationMapping, 'reservationMapping', err);
  else if (needsMapping) err('reservationMapping', 'required when reservations are pulled or received by webhook');
  if (d.webhook !== undefined) checkWebhook(d.webhook, 'webhook', err);
  if (isPlainObject(caps) && caps.webhooks === true && d.webhook === undefined) err('webhook', 'required when capabilities.webhooks is true');
  if (isPlainObject(caps) && caps.polling === true && !(isPlainObject(ops) && (ops.listReservations || ops.getReservation))) err('capabilities.polling', 'needs operations.listReservations');

  // limits --------------------------------------------------------------------------------------------------------
  if (d.limits !== undefined) {
    const l = d.limits;
    if (!isPlainObject(l)) err('limits', 'must be an object');
    else {
      onlyKeys(l, ['timeoutMs', 'maxRequestBytes', 'maxResponseBytes'], 'limits', err);
      intRange(l.timeoutMs, 'limits.timeoutMs', 500, PLATFORM_LIMITS.timeoutMs, err);
      intRange(l.maxRequestBytes, 'limits.maxRequestBytes', 1024, PLATFORM_LIMITS.maxRequestBytes, err);
      intRange(l.maxResponseBytes, 'limits.maxResponseBytes', 1024, PLATFORM_LIMITS.maxResponseBytes, err);
    }
  }
  if (d.retry !== undefined) {
    const r = d.retry;
    if (!isPlainObject(r)) err('retry', 'must be an object');
    else {
      onlyKeys(r, ['maxAttempts', 'baseDelayMs', 'maxDelayMs', 'retryOnStatus'], 'retry', err);
      intRange(r.maxAttempts, 'retry.maxAttempts', 1, PLATFORM_LIMITS.maxAttempts, err);
      intRange(r.baseDelayMs, 'retry.baseDelayMs', 50, 60_000, err);
      intRange(r.maxDelayMs, 'retry.maxDelayMs', 50, 300_000, err);
      if (!Array.isArray(r.retryOnStatus) || r.retryOnStatus.some((s) => !Number.isInteger(s) || (s as number) < 400 || (s as number) > 599)) err('retry.retryOnStatus', 'must be a list of HTTP status codes 400-599');
    }
  }
  if (d.rateLimit !== undefined) {
    const r = d.rateLimit;
    if (!isPlainObject(r)) err('rateLimit', 'must be an object');
    else {
      onlyKeys(r, ['requestsPerSecond'], 'rateLimit', err);
      if (typeof r.requestsPerSecond !== 'number' || !(r.requestsPerSecond > 0) || r.requestsPerSecond > PLATFORM_LIMITS.requestsPerSecond) err('rateLimit.requestsPerSecond', `must be > 0 and <= ${PLATFORM_LIMITS.requestsPerSecond}`);
    }
  }
  if (d.defaultPollIntervalSeconds !== undefined) intRange(d.defaultPollIntervalSeconds, 'defaultPollIntervalSeconds', 60, 86_400, err);
  if (d.documentationUrl !== undefined && !isHttpsUrl(d.documentationUrl)) err('documentationUrl', 'must be an https URL');

  if (errors.length) return { ok: false, errors, warnings };
  return { ok: true, errors, warnings, definition: d as unknown as ProviderDefinition };
}

// ------------------------------------------------------------------ parts

type Err = (path: string, message: string) => void;

function checkBaseUrl(v: unknown, path: string, hosts: Set<string>, opts: ValidateOptions, err: Err) {
  if (typeof v !== 'string') return err(path, 'required');
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return err(path, 'is not a valid URL');
  }
  const https = u.protocol === 'https:';
  if (!https && !(opts.allowInsecureHosts && u.protocol === 'http:')) err(path, 'must use https');
  if (u.username || u.password) err(path, 'must not contain credentials');
  if (u.search || u.hash) err(path, 'must not contain a query string or fragment');
  if (u.port && !opts.allowInsecureHosts && u.port !== '443') err(path, 'only the default https port is allowed');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!hosts.has(host)) err(path, `host ${host} is not listed in allowedHosts`);
}

/** `engineHeader`: the header carries a credential/signature the engine sets (auth, signing, webhook, idempotency): only HARD_DENY applies. Otherwise it is an extra operation header. */
function checkHeaderName(v: unknown, path: string, err: Err, engineHeader = false) {
  if (typeof v !== 'string' || !HEADER_NAME.test(v)) return err(path, 'must be a valid header name');
  const deny = engineHeader ? HARD_DENY : OP_HEADER_DENY;
  if (deny.has(v.toLowerCase())) err(path, `header ${v} may not be used here`);
}

function checkTemplate(v: unknown, path: string, op: OperationName, err: Err, opts: { inPath?: boolean; itemFields?: readonly string[] | null; bodyOnly?: boolean } = {}) {
  if (typeof v !== 'string') return err(path, 'must be a string');
  if (/[\r\n\u0000]/.test(v)) return err(path, 'must not contain control characters');
  const allowed = PLACEHOLDERS[op];
  const stripped = v.replace(PLACEHOLDER, '');
  if (/[{}]/.test(stripped)) err(path, 'contains an unbalanced or malformed placeholder');
  for (const p of parsePlaceholders(v)) {
    if (p.transform && !(TRANSFORMS as readonly string[]).includes(p.transform)) err(path, `unknown transform ${p.transform}`);
    if (p.name.startsWith('item.')) {
      const field = p.name.slice(5);
      if (!opts.itemFields || !opts.itemFields.includes(field)) err(path, `{${p.name}} is not available here`);
    } else if (!allowed.includes(p.name)) err(path, `placeholder {${p.name}} is not available in ${op}`);
  }
  void opts.inPath;
}

function checkOperation(name: OperationName, spec: unknown, path: string, hosts: Set<string>, err: Err, warn: Err) {
  void hosts;
  void warn;
  if (!isPlainObject(spec)) return err(path, 'must be an object');
  onlyKeys(spec, ['method', 'path', 'query', 'headers', 'body', 'items', 'fields', 'pagination', 'batchSize', 'idempotencyHeader', 'acceptedPath', 'rejectedPath'], path, err);
  const isRead = name.startsWith('list') || name === 'getReservation' || name === 'healthCheck';
  const methods = isRead ? ['GET', 'POST'] : ['PUT', 'POST', 'PATCH'];
  if (typeof spec.method !== 'string' || !methods.includes(spec.method)) err(`${path}.method`, `must be one of ${methods.join(', ')}`);
  if (name === 'healthCheck' && spec.method !== 'GET') err(`${path}.method`, 'the health check must be a GET: it must never change anything');
  if (typeof spec.path !== 'string' || !spec.path.startsWith('/') || spec.path.startsWith('//') || /\.\.|[?#\\]|:\/\//.test(spec.path)) err(`${path}.path`, 'must be a path starting with a single "/" (no "..", query, fragment or scheme)');
  else {
    checkTemplate(spec.path, `${path}.path`, name, err, { inPath: true });
    for (const p of parsePlaceholders(spec.path)) {
      if (!PATH_SEGMENT_PLACEHOLDERS.has(p.name)) err(`${path}.path`, `{${p.name}} may not be used in a path (identifiers only)`);
    }
  }
  const itemFields = ITEM_FIELDS[name] ?? null;
  if (spec.query !== undefined) {
    if (!isPlainObject(spec.query)) err(`${path}.query`, 'must be an object');
    else for (const [k, v] of Object.entries(spec.query)) {
      if (!/^[A-Za-z][A-Za-z0-9_.\[\]-]{0,63}$/.test(k)) err(`${path}.query.${k}`, 'invalid parameter name');
      checkTemplate(v, `${path}.query.${k}`, name, err);
    }
  }
  if (spec.headers !== undefined) {
    if (!isPlainObject(spec.headers)) err(`${path}.headers`, 'must be an object');
    else for (const [k, v] of Object.entries(spec.headers)) {
      checkHeaderName(k, `${path}.headers.${k}`, err, false);
      checkTemplate(v, `${path}.headers.${k}`, name, err);
    }
  }
  if (spec.body !== undefined) {
    if (isRead && spec.method === 'GET') err(`${path}.body`, 'a GET request has no body');
    checkBody(spec.body, `${path}.body`, name, itemFields, err, 0);
  }
  if (!isRead && spec.body === undefined && name !== 'ackReservation') err(`${path}.body`, 'a push operation needs a body template');
  if (spec.items !== undefined) checkJsonPath(spec.items, `${path}.items`, err);
  if (spec.fields !== undefined) {
    if (!isPlainObject(spec.fields)) err(`${path}.fields`, 'must be an object');
    else for (const [k, v] of Object.entries(spec.fields)) checkField(v, `${path}.fields.${k}`, err);
  }
  if (name.startsWith('list') && !spec.fields && name !== 'listReservations') err(`${path}.fields`, 'required: map the provider fields to Tirvona fields');
  if (spec.pagination !== undefined) checkPagination(spec.pagination, `${path}.pagination`, err);
  if (spec.batchSize !== undefined) intRange(spec.batchSize, `${path}.batchSize`, 1, PLATFORM_LIMITS.batchSize, err);
  if (spec.idempotencyHeader !== undefined) checkHeaderName(spec.idempotencyHeader, `${path}.idempotencyHeader`, err, true);
  if (spec.acceptedPath !== undefined) checkJsonPath(spec.acceptedPath, `${path}.acceptedPath`, err);
  if (spec.rejectedPath !== undefined) checkJsonPath(spec.rejectedPath, `${path}.rejectedPath`, err);
  if (name === 'listReservations' && spec.fields === undefined) {
    // reservation fields come from reservationMapping + fields; the minimum set is checked at mapping time
    err(`${path}.fields`, 'required: externalReservationId, externalListingId, checkIn, checkOut, adults, guestFirstName, currency (and optional ones)');
  }
  if (name === 'listReservations' || name === 'getReservation') {
    const f = isPlainObject(spec.fields) ? spec.fields : {};
    for (const required of ['externalReservationId', 'externalListingId', 'checkIn', 'checkOut', 'adults', 'guestFirstName', 'currency']) {
      if (f[required] === undefined) err(`${path}.fields.${required}`, 'required');
    }
  }
}

const MAX_BODY_DEPTH = 8;
function checkBody(v: unknown, path: string, op: OperationName, itemFields: readonly string[] | null, err: Err, depth: number, inEach = false) {
  if (depth > MAX_BODY_DEPTH) return err(path, 'is nested too deeply');
  if (v === null || typeof v === 'number' || typeof v === 'boolean') return;
  if (typeof v === 'string') return checkTemplate(v, path, op, err, { itemFields: inEach ? itemFields : null });
  if (Array.isArray(v)) {
    if (v.length > 50) err(path, 'too many elements');
    return v.forEach((x, i) => checkBody(x, `${path}[${i}]`, op, itemFields, err, depth + 1, inEach));
  }
  if (isPlainObject(v)) {
    if ('$each' in v) {
      onlyKeys(v, ['$each', 'item'], path, err);
      if (v.$each !== 'updates') err(`${path}.$each`, 'only "updates" can be iterated');
      if (!itemFields) err(`${path}.$each`, `${op} has no updates to iterate`);
      if (inEach) err(`${path}.$each`, '$each cannot be nested');
      return checkBody(v.item, `${path}.item`, op, itemFields, err, depth + 1, true);
    }
    for (const [k, x] of Object.entries(v)) {
      if (k.startsWith('$')) err(`${path}.${k}`, 'unknown directive');
      else if (FORBIDDEN_KEYS.has(k) || k.length > 64) err(`${path}.${k}`, 'invalid key');
      checkBody(x, `${path}.${k}`, op, itemFields, err, depth + 1, inEach);
    }
    return;
  }
  err(path, 'unsupported value');
}

function checkPagination(v: unknown, path: string, err: Err) {
  if (!isPlainObject(v)) return err(path, 'must be an object');
  onlyKeys(v, ['type', 'param', 'sizeParam', 'pageSize', 'nextPath', 'maxPages', 'firstPage'], path, err);
  if (!['NONE', 'CURSOR', 'PAGE', 'OFFSET'].includes(v.type as string)) err(`${path}.type`, 'must be NONE, CURSOR, PAGE or OFFSET');
  if (v.type !== 'NONE') {
    if (typeof v.param !== 'string' || !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(v.param)) err(`${path}.param`, 'required');
    if (v.sizeParam !== undefined && (typeof v.sizeParam !== 'string' || !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(v.sizeParam))) err(`${path}.sizeParam`, 'invalid');
    if (v.pageSize !== undefined) intRange(v.pageSize, `${path}.pageSize`, 1, 1000, err);
    if (v.maxPages !== undefined) intRange(v.maxPages, `${path}.maxPages`, 1, PLATFORM_LIMITS.maxPages, err);
    if (v.firstPage !== undefined) intRange(v.firstPage, `${path}.firstPage`, 0, 1, err);
  }
  if (v.type === 'CURSOR') {
    if (typeof v.nextPath !== 'string') err(`${path}.nextPath`, 'required for CURSOR pagination');
    else checkJsonPath(v.nextPath, `${path}.nextPath`, err);
  }
}

function checkField(v: unknown, path: string, err: Err) {
  if (typeof v === 'string') return checkJsonPath(v, path, err);
  if (!isPlainObject(v)) return err(path, 'must be a path string or an object with "path"');
  onlyKeys(v, ['path', 'transform', 'map', 'default', 'unit'], path, err);
  checkJsonPath(v.path, `${path}.path`, err);
  if (v.transform !== undefined && !(TRANSFORMS as readonly string[]).includes(v.transform as string)) err(`${path}.transform`, 'unknown transform');
  if (v.unit !== undefined && v.unit !== 'MINOR' && v.unit !== 'MAJOR') err(`${path}.unit`, 'must be MINOR or MAJOR');
  if (v.map !== undefined) {
    if (!isPlainObject(v.map) || Object.keys(v.map).length > 100 || Object.values(v.map).some((x) => typeof x !== 'string')) err(`${path}.map`, 'must be an object of strings (max 100 entries)');
  }
}

/** The JSONPath subset: `$`, `.name`, `['name']`, `[0]`, `[*]`. */
const JSONPATH = /^\$(?:\.[A-Za-z_][A-Za-z0-9_-]*|\['[^'\\]{1,64}'\]|\[\d{1,4}\]|\[\*\])*$/;
export function checkJsonPath(v: unknown, path: string, err: Err) {
  if (typeof v !== 'string' || v.length > 200 || !JSONPATH.test(v)) return err(path, 'must be a restricted JSONPath ($, .name, [\'name\'], [0], [*])');
  if (/(^|[.'\[])(__proto__|constructor|prototype)([.'\]\[]|$)/.test(v)) err(path, 'forbidden property name');
}

function checkReservationMapping(v: unknown, path: string, err: Err) {
  if (!isPlainObject(v)) return err(path, 'must be an object');
  onlyKeys(v, ['statusPath', 'statusMap', 'pricing', 'dateFormat', 'paymentCollection', 'paymentCollectedByChannel', 'paymentFields'], path, err);
  checkJsonPath(v.statusPath, `${path}.statusPath`, err);
  const kinds = ['RESERVATION_CREATED', 'RESERVATION_MODIFIED', 'RESERVATION_CANCELLED'];
  if (!isPlainObject(v.statusMap) || Object.keys(v.statusMap).length === 0 || Object.keys(v.statusMap).length > 50 || Object.values(v.statusMap).some((x) => !kinds.includes(x as string))) err(`${path}.statusMap`, `must map provider statuses to ${kinds.join(' | ')}`);
  if (!isPlainObject(v.pricing)) err(`${path}.pricing`, 'required');
  else {
    onlyKeys(v.pricing, ['mode', 'path', 'unit'], `${path}.pricing`, err);
    if (v.pricing.mode !== 'TOTAL' && v.pricing.mode !== 'NIGHTLY') err(`${path}.pricing.mode`, 'must be TOTAL or NIGHTLY');
    checkJsonPath(v.pricing.path, `${path}.pricing.path`, err);
    if (v.pricing.unit !== 'MINOR' && v.pricing.unit !== 'MAJOR') err(`${path}.pricing.unit`, 'must be MINOR or MAJOR');
  }
  if (v.dateFormat !== 'YYYY-MM-DD' && v.dateFormat !== 'ISO_DATETIME') err(`${path}.dateFormat`, 'must be YYYY-MM-DD or ISO_DATETIME');
  if (v.paymentCollection !== undefined && v.paymentCollection !== 'CHANNEL' && v.paymentCollection !== 'PROPERTY') err(`${path}.paymentCollection`, 'must be CHANNEL or PROPERTY, or omitted when the provider does not say who collects');
  if (v.paymentCollectedByChannel !== undefined && typeof v.paymentCollectedByChannel !== 'boolean') err(`${path}.paymentCollectedByChannel`, 'must be true or false (legacy; prefer paymentCollection, or omit when unknown)');
  if (v.paymentCollection !== undefined && v.paymentCollectedByChannel !== undefined) err(`${path}.paymentCollectedByChannel`, 'cannot be combined with paymentCollection');
  if (v.paymentFields !== undefined) checkPaymentFields(v.paymentFields, `${path}.paymentFields`, err);
}

function checkPaymentFields(v: unknown, path: string, err: Err) {
  if (!isPlainObject(v)) return err(path, 'must be an object');
  onlyKeys(v, ['statusPath', 'statusMap', 'payoutStatusPath', 'payoutStatusMap', 'payoutDatePath', 'commissionPath', 'netAmountPath', 'amountUnit'], path, err);
  for (const k of ['statusPath', 'payoutStatusPath', 'payoutDatePath', 'commissionPath', 'netAmountPath']) if (v[k] !== undefined) checkJsonPath(v[k], `${path}.${k}`, err);
  const map = (k: 'statusMap' | 'payoutStatusMap', allowed: string[]) => {
    const m = v[k];
    if (m === undefined) return;
    if (!isPlainObject(m) || Object.keys(m).length === 0 || Object.keys(m).length > 50 || Object.values(m).some((x) => !allowed.includes(x as string))) err(`${path}.${k}`, `must map provider words to ${allowed.join(' | ')}`);
  };
  map('statusMap', ['UNPAID', 'PAID', 'PARTIALLY_PAID', 'REFUNDED', 'PARTIALLY_REFUNDED', 'FAILED']);
  map('payoutStatusMap', ['PENDING', 'COMPLETED', 'FAILED']);
  if (v.statusMap !== undefined && v.statusPath === undefined) err(`${path}.statusMap`, 'needs statusPath');
  if (v.payoutStatusMap !== undefined && v.payoutStatusPath === undefined) err(`${path}.payoutStatusMap`, 'needs payoutStatusPath');
  if ((v.commissionPath !== undefined || v.netAmountPath !== undefined) && v.amountUnit !== 'MINOR' && v.amountUnit !== 'MAJOR') err(`${path}.amountUnit`, 'must be MINOR or MAJOR when commissionPath or netAmountPath is set');
}

function checkWebhook(v: unknown, path: string, err: Err) {
  if (!isPlainObject(v)) return err(path, 'must be an object');
  onlyKeys(v, ['signature', 'eventIdPath', 'eventTypePath', 'typeMap', 'reservationPath'], path, err);
  const s = v.signature;
  if (!isPlainObject(s)) err(`${path}.signature`, 'required: unsigned webhooks are not accepted');
  else {
    onlyKeys(s, ['scheme', 'header', 'format', 'signedPayload', 'timestampHeader', 'toleranceSeconds'], `${path}.signature`, err);
    if (s.scheme !== 'HMAC_SHA256') err(`${path}.signature.scheme`, 'must be HMAC_SHA256');
    checkHeaderName(s.header, `${path}.signature.header`, err, true);
    if (!['hex', 'base64', 'stripe'].includes(s.format as string)) err(`${path}.signature.format`, 'must be hex, base64 or stripe');
    if (s.signedPayload !== 'RAW_BODY' && s.signedPayload !== 'TIMESTAMP.RAW_BODY') err(`${path}.signature.signedPayload`, 'must be RAW_BODY or TIMESTAMP.RAW_BODY');
    if (s.signedPayload === 'TIMESTAMP.RAW_BODY' && s.format !== 'stripe') checkHeaderName(s.timestampHeader, `${path}.signature.timestampHeader`, err, true);
    if (s.toleranceSeconds !== undefined) intRange(s.toleranceSeconds, `${path}.signature.toleranceSeconds`, 30, 3600, err);
  }
  checkJsonPath(v.eventIdPath, `${path}.eventIdPath`, err);
  checkJsonPath(v.eventTypePath, `${path}.eventTypePath`, err);
  checkJsonPath(v.reservationPath, `${path}.reservationPath`, err);
  const kinds = ['RESERVATION_CREATED', 'RESERVATION_MODIFIED', 'RESERVATION_CANCELLED'];
  if (!isPlainObject(v.typeMap) || Object.keys(v.typeMap).length === 0 || Object.values(v.typeMap).some((x) => !kinds.includes(x as string))) err(`${path}.typeMap`, `must map provider event types to ${kinds.join(' | ')}`);
}

// ------------------------------------------------------------------ helpers

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
}
function onlyKeys(o: Record<string, unknown>, allowed: string[], path: string, err: Err) {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) err(path === '$' ? k : `${path}.${k}`, 'unknown key');
}
function rejectForbiddenKeys(v: unknown, path: string, err: Err, depth = 0) {
  if (depth > 20) return err(path, 'nested too deeply');
  if (Array.isArray(v)) return v.forEach((x, i) => rejectForbiddenKeys(x, `${path}[${i}]`, err, depth + 1));
  if (v && typeof v === 'object') {
    for (const k of Object.getOwnPropertyNames(v)) {
      if (FORBIDDEN_KEYS.has(k)) err(`${path}.${k}`, 'forbidden key');
      else rejectForbiddenKeys((v as Record<string, unknown>)[k], `${path}.${k}`, err, depth + 1);
    }
  }
}
function intRange(v: unknown, path: string, min: number, max: number, err: Err) {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) err(path, `must be an integer from ${min} to ${max}`);
}
function isHttpsUrl(v: unknown): boolean {
  try {
    return typeof v === 'string' && new URL(v).protocol === 'https:';
  } catch {
    return false;
  }
}
