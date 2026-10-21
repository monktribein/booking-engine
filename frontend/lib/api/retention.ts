import { apiClient } from './client';

export interface RetentionPolicy {
  guestAnonymizeAfterDays: number | null;
  notificationRedactAfterDays: number | null;
  inboundPayloadRedactAfterDays: number | null;
  enabled: boolean;
  approvedAt: string | null;
  awaitingApproval: boolean;
}

export interface RetentionRunRecord {
  id: string;
  dryRun: boolean;
  triggeredBy: string;
  summary: { guests: number; reservations: number; notifications: number; inboundEvents?: number };
  createdAt: string;
}

export interface RetentionOverview {
  policy: RetentionPolicy;
  runs: RetentionRunRecord[];
}

export interface RetentionResult {
  dryRun: boolean;
  applied: boolean;
  reason?: string;
  summary: { guests: number; reservations: number; notifications: number; inboundEvents: number };
  moreGuests: boolean;
}

/** Personal-data retention (owners only). Counts only; no personal data ever comes back from these endpoints. */
export const retentionApi = {
  get: () => apiClient<RetentionOverview>('/organizations/me/retention'),
  set: (body: { guestAnonymizeAfterDays?: number | null; notificationRedactAfterDays?: number | null; inboundPayloadRedactAfterDays?: number | null }) =>
    apiClient<RetentionOverview>('/organizations/me/retention', { method: 'PUT', body: JSON.stringify(body) }),
  dryRun: () => apiClient<RetentionResult>('/organizations/me/retention/dry-run', { method: 'POST', body: JSON.stringify({}) }),
  approve: () => apiClient<RetentionOverview>('/organizations/me/retention/approve', { method: 'POST', body: JSON.stringify({}) }),
  disable: () => apiClient<RetentionOverview>('/organizations/me/retention/disable', { method: 'POST', body: JSON.stringify({}) }),
  run: () => apiClient<RetentionResult>('/organizations/me/retention/run', { method: 'POST', body: JSON.stringify({ confirm: 'ANONYMIZE' }) }),
};
