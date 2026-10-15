import { vi } from 'vitest';

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

type Responder = (call: RecordedCall) => Response | Promise<Response>;

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
export const ok = <T,>(data: T, status = 200) => json({ success: true, data }, status);
export const fail = (status: number, code: string, message: string, details?: unknown) =>
  json({ success: false, error: { code, message, ...(details ? { details } : {}) } }, status);

/** Replaces global fetch with a recorder. `responder` decides each response (throw to simulate a network failure). */
export function mockFetch(responder: Responder) {
  const calls: RecordedCall[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: RecordedCall = {
      url: String(input),
      method: (init?.method ?? 'GET').toUpperCase(),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? init.body : undefined,
    };
    calls.push(call);
    return responder(call);
  });
  vi.stubGlobal('fetch', fn);
  return { calls, fn, count: (needle: string) => calls.filter((c) => c.url.includes(needle)).length };
}

export const API = 'http://localhost:3000';
