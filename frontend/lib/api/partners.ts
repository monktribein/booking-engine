import type { MarketplaceStatus, OrganizationStatus } from '@/types';
import { apiClient } from './client';

const json = (body: unknown) => JSON.stringify(body);

export interface Page<T> {
  items: T[];
  page: number;
  limit: number;
  total: number;
}

// ------------------------------------------------------------------ the partner's own organization

export interface Organization {
  _id: string;
  name: string;
  slug: string;
  status: OrganizationStatus;
  /** Why the platform rejected or suspended the organization, when it did. */
  statusReason?: string | null;
  approvedAt?: string | null;
  createdAt: string;
}

export const organizationApi = {
  me: () => apiClient<Organization>('/organizations/me'),
  rename: (name: string) => apiClient<Organization>('/organizations/me', { method: 'PATCH', body: json({ name }) }),
};

// ------------------------------------------------------------------ who can see and book a property

export interface Requirement {
  key: string;
  label: string;
  ok: boolean;
}

export interface Visibility {
  propertyStatus: string;
  suspendedReason: string | null;
  directBookingEnabled: boolean;
  slug: string;
  marketplace: { status: MarketplaceStatus; consentAt: string | null; reviewedAt: string | null; note: string | null };
  requirements: Requirement[];
  eligibleForMarketplace: boolean;
  publiclyBookable: boolean;
  listedOnMarketplace: boolean;
}

export const visibilityApi = {
  get: (propertyId: string) => apiClient<Visibility>(`/properties/${propertyId}/visibility`),
  setDirectBooking: (propertyId: string, directBookingEnabled: boolean) => apiClient<Visibility>(`/properties/${propertyId}/visibility`, { method: 'PATCH', body: json({ directBookingEnabled }) }),
  requestMarketplace: (propertyId: string) => apiClient<Visibility>(`/properties/${propertyId}/marketplace/request`, { method: 'POST', body: json({ consent: true }) }),
  withdrawMarketplace: (propertyId: string) => apiClient<Visibility>(`/properties/${propertyId}/marketplace/withdraw`, { method: 'POST' }),
};

// ------------------------------------------------------------------ integration requests (a request is not a connection)

export type IntegrationChannel = 'AIRBNB' | 'BOOKING_COM' | 'AGODA' | 'OTHER';
export type IntegrationRequestStatus = 'REQUESTED' | 'IN_REVIEW' | 'APPROVED' | 'REJECTED' | 'WITHDRAWN';

export interface IntegrationRequest {
  _id: string;
  channel: IntegrationChannel;
  status: IntegrationRequestStatus;
  propertyId: string | null;
  note: string | null;
  decisionNote: string | null;
  decidedAt: string | null;
  createdAt: string;
}

export const integrationRequestsApi = {
  list: () => apiClient<IntegrationRequest[]>('/integration-requests'),
  create: (body: { channel: IntegrationChannel; propertyId?: string; note?: string }) => apiClient<IntegrationRequest>('/integration-requests', { method: 'POST', body: json(body) }),
  withdraw: (id: string) => apiClient<IntegrationRequest>(`/integration-requests/${id}/withdraw`, { method: 'POST' }),
};

// ------------------------------------------------------------------ team

export interface Member {
  _id: string;
  name: string;
  email: string;
  role: string;
  status: string;
  lastLoginAt: string | null;
}

export const teamApi = {
  members: () => apiClient<Member[]>('/organizations/me/members'),
  inviteDeveloper: (body: { name: string; email: string }) => apiClient<Member>('/organizations/me/developers', { method: 'POST', body: json(body) }),
  removeDeveloper: (userId: string) => apiClient<{ ok: boolean }>(`/organizations/me/developers/${userId}`, { method: 'DELETE' }),
};

// ------------------------------------------------------------------ platform admin console

export interface AdminPartner {
  _id: string;
  name: string;
  slug: string;
  status: OrganizationStatus;
  statusReason: string | null;
  approvedAt: string | null;
  createdAt: string;
  ownerEmail: string | null;
  ownerName: string | null;
  properties: number;
  activeApiKeys: number;
}

export interface AdminPartnerDetail {
  _id: string;
  name: string;
  slug: string;
  status: OrganizationStatus;
  statusReason: string | null;
  createdAt: string;
  properties: { _id: string; name: string; slug: string; city: string; status: string; directBookingEnabled: boolean; marketplaceStatus: MarketplaceStatus; suspendedReason: string | null }[];
  users: { _id: string; name: string; email: string; role: string; status: string; lastLoginAt: string | null }[];
  integrationRequests: IntegrationRequest[];
}

export interface AdminProperty {
  _id: string;
  organizationId: string;
  organizationName: string | null;
  name: string;
  slug: string;
  city: string;
  state: string;
  status: string;
  directBookingEnabled: boolean;
  marketplaceStatus: MarketplaceStatus;
  marketplaceConsentAt: string | null;
  marketplaceNote: string | null;
  suspendedReason: string | null;
  createdAt: string;
}

export interface AdminIntegrationRequest {
  _id: string;
  organizationId: string;
  organizationName: string;
  propertyId: string | null;
  propertyName: string | null;
  channel: IntegrationChannel;
  status: IntegrationRequestStatus;
  note: string | null;
  decisionNote: string | null;
  createdAt: string;
}

export interface AdminAuditEntry {
  _id: string;
  action: string;
  entityType: string;
  entityId: string;
  organizationId: string | null;
  userId: string | null;
  createdAt: string;
  after?: Record<string, unknown> | null;
}

export interface AdminSyncErrors {
  syncJobs: Page<{ _id: string; channel: string; type: string; status: string; attempts: number; lastError: string | null; propertyId: string }>;
  recentFailures: { _id: string; channel: string; action: string; error: string | null; createdAt: string }[];
  failedWebhooks: { _id: string; channel: string; eventType: string; error: string | null; createdAt: string }[];
  failedQueueJobs: { queue: string; jobs: unknown[] }[];
}

export const adminApi = {
  partners: (params: { status?: string; q?: string; page?: number; limit?: number } = {}) => apiClient<Page<AdminPartner>>('/admin/partners', { params }),
  partner: (id: string) => apiClient<AdminPartnerDetail>(`/admin/partners/${id}`),
  partnerAction: (id: string, action: 'approve' | 'reject' | 'suspend' | 'reactivate', reason?: string) =>
    apiClient<{ _id: string; status: OrganizationStatus }>(`/admin/partners/${id}/${action}`, { method: 'POST', body: json(reason ? { reason } : {}) }),

  properties: (params: { status?: string; marketplaceStatus?: string; q?: string; page?: number; limit?: number } = {}) => apiClient<Page<AdminProperty>>('/admin/properties', { params }),
  marketplaceAction: (id: string, action: 'approve' | 'reject' | 'suspend' | 'reinstate', reason?: string) =>
    apiClient<unknown>(`/admin/properties/${id}/marketplace/${action}`, { method: 'POST', body: json(reason ? { reason } : {}) }),
  propertyAction: (id: string, action: 'suspend' | 'reactivate', reason?: string) => apiClient<unknown>(`/admin/properties/${id}/${action}`, { method: 'POST', body: json(reason ? { reason } : {}) }),

  integrationRequests: (params: { status?: string; page?: number; limit?: number } = {}) => apiClient<Page<AdminIntegrationRequest>>('/admin/integration-requests', { params }),
  decideIntegration: (id: string, status: 'IN_REVIEW' | 'APPROVED' | 'REJECTED', note?: string) => apiClient<unknown>(`/admin/integration-requests/${id}/decide`, { method: 'POST', body: json({ status, ...(note ? { note } : {}) }) }),

  syncErrors: () => apiClient<AdminSyncErrors>('/admin/sync-errors'),
  queues: () => apiClient<{ queue: string; counts: Record<string, number> }[]>('/admin/queues'),
  auditLogs: (params: { action?: string; page?: number; limit?: number } = {}) => apiClient<Page<AdminAuditEntry>>('/admin/audit-logs', { params }),
};
