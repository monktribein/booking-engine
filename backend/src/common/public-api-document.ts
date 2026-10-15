import type { OpenAPIObject } from '@nestjs/swagger';

const V1_DESCRIPTION = `
Server-to-server API for hotel availability, booking and cancellation, with signed webhooks.

**Authentication.** Create an API key in the dashboard (Developers → API keys) and send it as \`Authorization: Bearer tvk_...\`.
Keys are secrets: use them from your server only, never in browser or mobile code. A key belongs to one organization,
carries scopes (\`properties:read\`, \`availability:read\`, \`reservations:read\`, \`reservations:write\`) and may be restricted to specific properties.

**Envelope.** Success: \`{ "success": true, "data": ... }\`. Failure: \`{ "success": false, "error": { "code", "message", "details"? } }\`.
Money is an integer in minor units (paise). Dates are \`YYYY-MM-DD\`; timestamps are ISO 8601 UTC.

**Idempotency.** \`POST /v1/reservations\` requires an \`Idempotency-Key\` header. Retrying with the same key and body returns the original booking.

**Rate limits.** Per key; every response carries \`RateLimit-Limit\`, \`RateLimit-Remaining\`, \`RateLimit-Reset\`; \`429\` adds \`Retry-After\`.

**Versioning.** The version is in the path. Within v1 we only add fields, endpoints, enum values and event types; clients must ignore unknown fields.
Breaking changes ship as /v2 with at least 12 months of notice before v1 is retired. Every response carries \`X-Tirvona-Api-Version\`.

**Webhooks.** Register endpoints in the dashboard. Events (\`reservation.created\`, \`reservation.confirmed\`, \`reservation.cancelled\`, \`payment.succeeded\`, \`payment.failed\`) are POSTed as JSON with
\`Tirvona-Signature: t=<unix>,v1=<HMAC-SHA256(secret, "<t>.<raw body>")>\`, \`Tirvona-Event-Id\` (deduplicate on it) and \`Tirvona-Event-Type\`.
Respond 2xx within 10 s; other responses are retried with exponential backoff (12 attempts over about 17 hours). See docs/PUBLIC_API.md.
`.trim();

/** Everything under these path prefixes is part of the public contract. */
const PUBLIC_PREFIXES = ['/v1/', '/payments/verify'];

function collectRefs(node: unknown, out: Set<string>): void {
  if (Array.isArray(node)) return node.forEach((n) => collectRefs(n, out));
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === '$ref' && typeof v === 'string' && v.startsWith('#/components/schemas/')) out.add(v.slice('#/components/schemas/'.length));
      else collectRefs(v, out);
    }
  }
}

/** The full API document reduced to the public /v1 contract, with only the schemas it references. */
export function buildPublicApiDocument(full: OpenAPIObject): OpenAPIObject {
  const paths = Object.fromEntries(Object.entries(full.paths).filter(([p]) => PUBLIC_PREFIXES.some((x) => p.startsWith(x))));
  const schemas = (full.components?.schemas ?? {}) as Record<string, unknown>;
  const needed = new Set<string>();
  collectRefs(paths, needed);
  // Transitive closure: schemas referenced by schemas.
  for (let grew = true; grew; ) {
    grew = false;
    for (const name of [...needed]) {
      const before = needed.size;
      collectRefs(schemas[name], needed);
      if (needed.size > before) grew = true;
    }
  }
  const securitySchemes = Object.fromEntries(Object.entries(full.components?.securitySchemes ?? {}).filter(([k]) => k === 'api-key'));
  return {
    ...full,
    info: { ...full.info, title: 'Tirvona Public API', version: 'v1', description: V1_DESCRIPTION },
    tags: [],
    paths,
    components: { schemas: Object.fromEntries(Object.entries(schemas).filter(([k]) => needed.has(k))) as never, securitySchemes: securitySchemes as never },
  };
}
