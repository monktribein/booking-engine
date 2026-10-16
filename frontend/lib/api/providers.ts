import { apiClient } from './client';

/* Provider catalogue, connections to configured providers, reconciliation, published calendars and the platform admin's provider authoring. */

export interface CatalogueEntry {
  _id: string;
  code: string;
  name: string;
  kind: string;
  protocol: 'REST_JSON' | 'ICAL' | 'CODE' | string;
  builtIn: boolean;
  operational: boolean;
  capabilities: string[];
  authType: string | null;
  requiredCredentials: string[];
  supportsWebhooks: boolean;
  supportsPolling: boolean;
  sandboxAvailable: boolean;
  defaultPollIntervalSeconds: number | null;
  version: number | null;
}

export interface CredentialInput {
  API_KEY?: string;
  BEARER_TOKEN?: string;
  BASIC_USERNAME?: string;
  BASIC_PASSWORD?: string;
  SIGNING_SECRET?: string;
  WEBHOOK_SECRET?: string;
}

export interface FeedInput {
  name: string;
  url: string;
}

export interface ConnectionDetail {
  channel: string;
  provider: { code: string; name: string; version: number | null } | null;
  status: string;
  environment: string;
  externalAccountId: string | null;
  connectedAt: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
  capabilities: string[];
  /** What is stored, never the values. */
  credentials: { kind: string; storedAt: string; rotatedAt: string | null }[];
  polling: { intervalSeconds: number | null; lastPollAt: string | null; lastPollError: string | null; cursor: string | null };
  webhook: { url: string | null; signatureHeader: string } | null;
  feeds?: { id: string; name: string; host: string }[];
}

export interface ReconciliationRun {
  _id: string;
  status: 'RUNNING' | 'COMPLETED' | 'FAILED';
  startedAt: string;
  completedAt: string | null;
  remoteCount: number | null;
  localCount: number | null;
  issueCount: number;
  error: string | null;
}
export interface ReconciliationIssue {
  _id: string;
  kind: 'MISSING_LOCAL' | 'MISSING_REMOTE' | 'STATUS_MISMATCH' | 'DATE_MISMATCH' | 'UNMAPPED' | 'INGEST_FAILED';
  externalReservationId: string | null;
  reservationId: string | null;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface IcalFeedRow {
  _id: string;
  roomTypeId: string;
  roomType: string;
  label: string | null;
  createdAt: string;
  lastFetchedAt: string | null;
  revokedAt: string | null;
}

export interface CsvColumns {
  reference: string;
  checkIn: string;
  checkOut: string;
  adults: string;
  guestFirstName: string;
  total: string;
  guestLastName?: string;
  email?: string;
  phone?: string;
  notes?: string;
}
export interface CsvRowResult {
  line: number;
  reference?: string;
  status: 'OK' | 'IMPORTED' | 'DUPLICATE' | 'ERROR';
  errors: string[];
  summary?: { checkIn: string; checkOut: string; nights: number; adults: number; total: number; guest: string };
}
export interface CsvImportResult {
  dryRun: boolean;
  roomType: string;
  totals: { rows: number; ok: number; imported: number; duplicates: number; errors: number };
  rows: CsvRowResult[];
}

const json = (body: unknown) => JSON.stringify(body);
const ch = (propertyId: string, channel: string) => `/properties/${propertyId}/channels/${channel}`;

export const providersApi = {
  catalogue: () => apiClient<CatalogueEntry[]>('/channel-providers'),

  connection: (propertyId: string, channel: string) => apiClient<ConnectionDetail>(`${ch(propertyId, channel)}/connection`),
  connect: (propertyId: string, channel: string, input: { credentials?: CredentialInput; feeds?: FeedInput[]; environment?: 'production' | 'sandbox'; externalAccountId?: string; pollIntervalSeconds?: number | null }) =>
    apiClient<ConnectionDetail>(`${ch(propertyId, channel)}/credentials`, { method: 'POST', body: json(input) }),
  rotate: (propertyId: string, channel: string, input: { credentials?: CredentialInput; feeds?: FeedInput[] }) => apiClient<ConnectionDetail>(`${ch(propertyId, channel)}/credentials`, { method: 'PUT', body: json(input) }),
  test: (propertyId: string, channel: string) => apiClient<{ ok: boolean; message: string; latencyMs: number }>(`${ch(propertyId, channel)}/test`, { method: 'POST' }),
  settings: (propertyId: string, channel: string, input: { pollIntervalSeconds?: number | null; environment?: 'production' | 'sandbox' }) =>
    apiClient<ConnectionDetail>(`${ch(propertyId, channel)}/settings`, { method: 'PATCH', body: json(input) }),

  reconciliation: (propertyId: string, channel: string) => apiClient<{ runs: ReconciliationRun[]; issues: ReconciliationIssue[] }>(`${ch(propertyId, channel)}/reconciliation`),
  reconcile: (propertyId: string, channel: string) => apiClient<ReconciliationRun>(`${ch(propertyId, channel)}/reconciliation`, { method: 'POST' }),
  resolveIssue: (propertyId: string, channel: string, issueId: string, status: 'RESOLVED' | 'IGNORED', resolution: string) =>
    apiClient<unknown>(`${ch(propertyId, channel)}/reconciliation/issues/${issueId}`, { method: 'POST', body: json({ status, resolution }) }),

  icalFeeds: (propertyId: string) => apiClient<IcalFeedRow[]>(`/properties/${propertyId}/ical-feeds`),
  createIcalFeed: (propertyId: string, roomTypeId: string, label?: string) => apiClient<{ _id: string; url: string; note: string }>(`/properties/${propertyId}/ical-feeds`, { method: 'POST', body: json({ roomTypeId, label: label || undefined }) }),
  revokeIcalFeed: (propertyId: string, feedId: string) => apiClient<{ ok: boolean }>(`/properties/${propertyId}/ical-feeds/${feedId}`, { method: 'DELETE' }),

  importCsv: (propertyId: string, input: { csv: string; roomTypeId: string; ratePlanId?: string; columns: CsvColumns; dateFormat: string; dryRun: boolean }) =>
    apiClient<CsvImportResult>(`/properties/${propertyId}/reservations/import`, { method: 'POST', body: json(input) }),
};

// ---------------------------------------------------------------- platform admin

export interface AdminProvider {
  _id: string;
  code: string;
  name: string;
  kind: string;
  protocol: string;
  status: 'DRAFT' | 'ACTIVE' | 'DISABLED';
  builtIn: boolean;
  currentVersionId: string | null;
  createdAt: string;
}
export interface AdminProviderVersion {
  _id: string;
  version: number;
  status: 'DRAFT' | 'VALIDATED' | 'PUBLISHED' | 'RETIRED';
  definitionHash: string;
  validation: { ok: boolean; errors: { path: string; message: string }[]; warnings: { path: string; message: string }[] } | null;
  notes: string | null;
  publishedAt: string | null;
  createdAt: string;
  definition?: Record<string, unknown>;
}
export interface ValidationOutcome {
  ok: boolean;
  errors: { path: string; message: string }[];
  warnings: { path: string; message: string }[];
}
export interface DryRunOutcome {
  passed: boolean;
  steps: { step: string; ok: boolean; detail: string }[];
}

export const providerAdminApi = {
  list: () => apiClient<AdminProvider[]>('/admin/channel-providers'),
  create: (input: { code: string; name: string; kind: string }) => apiClient<AdminProvider>('/admin/channel-providers', { method: 'POST', body: json(input) }),
  get: (id: string) => apiClient<{ provider: AdminProvider; versions: AdminProviderVersion[] }>(`/admin/channel-providers/${id}`),
  version: (versionId: string) => apiClient<AdminProviderVersion>(`/admin/channel-providers/versions/${versionId}`),
  validate: (definition: unknown) => apiClient<ValidationOutcome>('/admin/channel-providers/validate', { method: 'POST', body: json({ definition }) }),
  createVersion: (id: string, definition: unknown, notes?: string) => apiClient<{ version: AdminProviderVersion; validation: ValidationOutcome }>(`/admin/channel-providers/${id}/versions`, { method: 'POST', body: json({ definition, notes: notes || undefined }) }),
  updateVersion: (versionId: string, definition: unknown) => apiClient<{ version: AdminProviderVersion; validation: ValidationOutcome }>(`/admin/channel-providers/versions/${versionId}`, { method: 'PUT', body: json({ definition }) }),
  diff: (a: string, b: string) => apiClient<{ path: string; from: unknown; to: unknown }[]>(`/admin/channel-providers/versions/${a}/diff/${b}`),
  dryRun: (versionId: string, input: { environment: 'production' | 'sandbox'; credentials: CredentialInput }) => apiClient<DryRunOutcome>(`/admin/channel-providers/versions/${versionId}/dry-run`, { method: 'POST', body: json(input) }),
  publish: (versionId: string) => apiClient<unknown>(`/admin/channel-providers/versions/${versionId}/publish`, { method: 'POST' }),
  rollback: (id: string, toVersionId: string) => apiClient<unknown>(`/admin/channel-providers/${id}/rollback`, { method: 'POST', body: json({ toVersionId }) }),
  setStatus: (id: string, status: 'ACTIVE' | 'DISABLED') => apiClient<AdminProvider>(`/admin/channel-providers/${id}/status`, { method: 'PATCH', body: json({ status }) }),
};
