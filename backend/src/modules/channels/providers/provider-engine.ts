import type { BodyTemplate, FieldSpec, TransformName } from './provider-definition';
import { parsePlaceholders } from './provider-definition';

/**
 * The (deliberately tiny) interpreter for provider definitions: restricted JSONPath extraction, whitelisted placeholder
 * substitution and a fixed set of named transforms. No eval, no dynamic property access beyond plain own-key lookup, no
 * prototype traversal. Everything here is a pure function.
 */

export class DefinitionRuntimeError extends Error {}

const BLOCKED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const TOKEN = /\.([A-Za-z_][A-Za-z0-9_-]*)|\['([^'\\]{1,64})'\]|\[(\d{1,4})\]|\[\*\]/y;

type Segment = { key: string } | { index: number } | { wildcard: true };

const parsedPaths = new Map<string, Segment[]>();
function parsePath(path: string): Segment[] {
  const cached = parsedPaths.get(path);
  if (cached) return cached;
  if (!path.startsWith('$')) throw new DefinitionRuntimeError(`invalid path ${path}`);
  const segs: Segment[] = [];
  TOKEN.lastIndex = 1;
  let pos = 1;
  while (pos < path.length) {
    TOKEN.lastIndex = pos;
    const m = TOKEN.exec(path);
    if (!m || m.index !== pos) throw new DefinitionRuntimeError(`invalid path ${path}`);
    if (m[1] !== undefined || m[2] !== undefined) {
      const key = (m[1] ?? m[2]) as string;
      if (BLOCKED_KEYS.has(key)) throw new DefinitionRuntimeError('forbidden property name in path');
      segs.push({ key });
    } else if (m[3] !== undefined) segs.push({ index: Number(m[3]) });
    else segs.push({ wildcard: true });
    pos = TOKEN.lastIndex;
  }
  if (parsedPaths.size > 2000) parsedPaths.clear();
  parsedPaths.set(path, segs);
  return segs;
}

/** All values the path selects (a wildcard fans out). Missing properties select nothing. */
export function extractAll(root: unknown, path: string): unknown[] {
  let current: unknown[] = [root];
  for (const seg of parsePath(path)) {
    const next: unknown[] = [];
    for (const v of current) {
      if ('key' in seg) {
        if (v !== null && typeof v === 'object' && !Array.isArray(v) && Object.prototype.hasOwnProperty.call(v, seg.key)) next.push((v as Record<string, unknown>)[seg.key]);
      } else if ('index' in seg) {
        if (Array.isArray(v) && seg.index < v.length) next.push(v[seg.index]);
      } else if (Array.isArray(v)) next.push(...v);
    }
    current = next;
    if (current.length > 10_000) throw new DefinitionRuntimeError('path selects too many values');
  }
  return current;
}

export function extractOne(root: unknown, path: string): unknown {
  const all = extractAll(root, path);
  return all.length ? all[0] : undefined;
}

// ------------------------------------------------------------------ transforms

export function applyTransform(name: TransformName, value: unknown): unknown {
  switch (name) {
    case 'minorToMajor': {
      const n = Number(value);
      if (!Number.isFinite(n)) throw new DefinitionRuntimeError('minorToMajor needs a number');
      return Math.round(n) / 100;
    }
    case 'majorToMinor': {
      const n = Number(value);
      if (!Number.isFinite(n)) throw new DefinitionRuntimeError('majorToMinor needs a number');
      return Math.round(n * 100);
    }
    case 'upper':
      return String(value).toUpperCase();
    case 'lower':
      return String(value).toLowerCase();
    case 'int': {
      const n = Number(value);
      if (!Number.isFinite(n)) throw new DefinitionRuntimeError('int needs a number');
      return Math.trunc(n);
    }
    case 'string':
      return String(value);
    case 'dateCompact':
      return String(value).replace(/-/g, '');
    case 'boolInt':
      return value === true || value === 1 || value === '1' || value === 'true' ? 1 : 0;
  }
}

/** Reads one mapped field out of an item. `undefined` when absent and no default is configured. */
export function readField(item: unknown, spec: FieldSpec): unknown {
  const s = typeof spec === 'string' ? { path: spec } : spec;
  let v = extractOne(item, s.path);
  if (v === undefined || v === null) return 'default' in s ? s.default : undefined;
  if (s.map) {
    const mapped = s.map[String(v)];
    if (mapped === undefined) return 'default' in s ? s.default : undefined;
    v = mapped;
  }
  if (s.transform) v = applyTransform(s.transform, v);
  return v;
}

// ------------------------------------------------------------------ templates

export type TemplateContext = Record<string, string | number | boolean | null | undefined>;

function lookup(ctx: TemplateContext, name: string): string | number | boolean | null | undefined {
  if (BLOCKED_KEYS.has(name)) throw new DefinitionRuntimeError('forbidden placeholder');
  return Object.prototype.hasOwnProperty.call(ctx, name) ? ctx[name] : undefined;
}

/** Identifiers in a URL path: encoded, and never able to climb or empty the path. */
export function pathSegment(value: string): string {
  if (value === '' || value === '.' || value === '..') throw new DefinitionRuntimeError('unsafe path segment');
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new DefinitionRuntimeError('control characters in path segment');
  return encodeURIComponent(value);
}

/** Substitutes placeholders in a string. `mode` decides the escaping of the substituted values. */
export function renderString(template: string, ctx: TemplateContext, mode: 'path' | 'text' = 'text'): string {
  let out = template;
  for (const p of parsePlaceholders(template)) {
    const raw = lookup(ctx, p.name);
    if (raw === undefined || raw === null) throw new DefinitionRuntimeError(`value for {${p.name}} is not available`);
    const v = p.transform ? applyTransform(p.transform as TransformName, raw) : raw;
    const str = String(v);
    if (/[\r\n\u0000]/.test(str)) throw new DefinitionRuntimeError(`{${p.name}} contains control characters`);
    out = out.split(p.raw).join(mode === 'path' ? pathSegment(str) : str);
  }
  return out;
}

const SOLE_PLACEHOLDER = /^\{([A-Za-z][A-Za-z0-9_.]*)(?:\|([A-Za-z]+))?\}$/;

/** Body templates: a string that is exactly one placeholder keeps the value's type (number, boolean). */
export function renderBody(tmpl: BodyTemplate, ctx: TemplateContext, updates?: TemplateContext[]): unknown {
  if (tmpl === null || typeof tmpl === 'number' || typeof tmpl === 'boolean') return tmpl;
  if (typeof tmpl === 'string') {
    const sole = SOLE_PLACEHOLDER.exec(tmpl);
    if (sole) {
      const raw = lookup(ctx, sole[1]);
      if (raw === undefined) throw new DefinitionRuntimeError(`value for {${sole[1]}} is not available`);
      if (raw === null) return null;
      return sole[2] ? applyTransform(sole[2] as TransformName, raw) : raw;
    }
    return renderString(tmpl, ctx, 'text');
  }
  if (Array.isArray(tmpl)) return tmpl.map((x) => renderBody(x, ctx, updates));
  if ('$each' in tmpl) {
    const item = (tmpl as { item: BodyTemplate }).item;
    return (updates ?? []).map((u) => renderBody(item, { ...ctx, ...Object.fromEntries(Object.entries(u).map(([k, v]) => [`item.${k}`, v])) }));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(tmpl)) {
    if (BLOCKED_KEYS.has(k)) continue;
    out[k] = renderBody(v, ctx, updates);
  }
  return out;
}

// ------------------------------------------------------------------ redaction

/** Removes every known secret value (and the common credential shapes) from text before it is logged, stored or returned. */
export function redactText(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 4) out = out.split(s).join('[REDACTED]');
  }
  // Bearer/Basic first, so "Authorization: Bearer <token>" loses the token and not just the word "Bearer".
  return out
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, '$1 [REDACTED]')
    .replace(/(authorization|x-api-key|api[-_]?key|token|secret|password|signature)(["']?\s*[:=]\s*["']?)([^\s"',;&]{4,})/gi, '$1$2[REDACTED]');
}

/** A URL for logs: credentials and secret-looking query values removed. */
export function redactUrl(raw: string, secretParams: readonly string[] = []): string {
  try {
    const u = new URL(raw);
    u.username = '';
    u.password = '';
    for (const k of [...u.searchParams.keys()]) {
      if (secretParams.includes(k) || /key|token|secret|signature|password|auth/i.test(k)) u.searchParams.set(k, '[REDACTED]');
    }
    return u.toString();
  } catch {
    return '[invalid url]';
  }
}
