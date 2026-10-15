import { ApiError } from '../api/client';

export type ErrorKind = 'network' | 'auth' | 'permission' | 'validation' | 'not-found' | 'conflict' | 'server' | 'unknown';

export interface DescribedError {
  kind: ErrorKind;
  title: string;
  /** Safe to show to users: only the backend's own message for 4xx, a generic text for 5xx/network. */
  message: string;
  /** Whether trying the same request again can reasonably succeed. */
  retryable: boolean;
  status?: number;
  code?: string;
  /** Field -> messages, when the backend rejected the input (VALIDATION_ERROR). */
  fields?: Record<string, string[]>;
}

/** Turns any thrown value into something the UI can render consistently (never leaks stack traces or server internals). */
export function describeError(err: unknown): DescribedError {
  if (!(err instanceof ApiError)) {
    return { kind: 'unknown', title: 'Something went wrong', message: 'An unexpected error occurred. Please try again.', retryable: true };
  }
  const { status, code } = err;
  const base = { status, code };
  if (status === 0 || code === 'NETWORK_ERROR') {
    return { ...base, kind: 'network', title: 'Cannot reach the server', message: 'Cannot reach the server. Check your connection and try again.', retryable: true };
  }
  if (status === 401) {
    return { ...base, kind: 'auth', title: 'Please sign in again', message: 'Your session has expired or is no longer valid.', retryable: false };
  }
  if (status === 403) {
    return { ...base, kind: 'permission', title: 'Not allowed', message: err.message || 'Your role does not allow this action.', retryable: false };
  }
  if (status === 404) {
    return { ...base, kind: 'not-found', title: 'Not found', message: err.message || 'The requested item does not exist.', retryable: false };
  }
  if (status === 409 || status === 422) {
    return { ...base, kind: 'conflict', title: 'Request could not be completed', message: err.message, retryable: false };
  }
  if (status === 400) {
    const fields = (err.details as { fields?: Record<string, string[]> } | undefined)?.fields;
    return { ...base, kind: 'validation', title: 'Please check your input', message: err.message, retryable: false, fields };
  }
  if (status === 429) {
    return { ...base, kind: 'server', title: 'Too many requests', message: 'Please wait a moment and try again.', retryable: true };
  }
  if (status >= 500) {
    return { ...base, kind: 'server', title: 'Server error', message: 'The server had a problem. Please try again shortly.', retryable: true };
  }
  return { ...base, kind: 'unknown', title: 'Request failed', message: err.message || 'The request failed.', retryable: false };
}

/** One-line message for toasts / inline form errors. */
export function errorMessage(err: unknown): string {
  const d = describeError(err);
  if (d.fields) {
    const first = Object.entries(d.fields)[0];
    if (first) return `${first[0]}: ${first[1][0]}`;
  }
  return d.message;
}

/**
 * Message for credential forms (sign in, register, forgot password). A 401 here means "wrong credentials",
 * not "your session expired", so the backend's own wording is used. 5xx and network failures stay generic.
 */
export function credentialErrorMessage(err: unknown): string {
  if (err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 429) {
    const fields = (err.details as { fields?: Record<string, string[]> } | undefined)?.fields;
    const first = fields && Object.entries(fields)[0];
    return first ? `${first[0]}: ${first[1][0]}` : err.message;
  }
  return errorMessage(err);
}
