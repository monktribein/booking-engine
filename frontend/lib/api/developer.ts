import { apiClient } from './client';

/** Scopes an API key can hold (must match the backend's API_SCOPES). `sensitive` ones reveal personal/financial data or change prices and inventory: never selected by default. */
export const API_SCOPES = [
  { value: 'properties:read', label: 'Read properties', sensitive: false },
  { value: 'availability:read', label: 'Search availability', sensitive: false },
  { value: 'rates:read', label: 'Read rate plans and prices', sensitive: false },
  { value: 'inventory:read', label: 'Read inventory and restrictions', sensitive: false },
  { value: 'reservations:read', label: 'Read reservations (guest contact hidden unless "Read guest details")', sensitive: false },
  { value: 'reservations:write', label: 'Create, change and cancel reservations', sensitive: true },
  { value: 'rates:write', label: 'Change prices', sensitive: true },
  { value: 'inventory:write', label: 'Change restrictions and stop-sell', sensitive: true },
  { value: 'guests:read', label: 'Read guest details (name, e-mail, phone)', sensitive: true },
  { value: 'payments:read', label: 'Read payments and refunds', sensitive: true },
] as const;

/** What a new key gets unless the owner chooses more: read-only, no personal data. */
export const DEFAULT_SCOPES: string[] = API_SCOPES.filter((s) => !s.sensitive).map((s) => s.value);

/** Event types a webhook endpoint can subscribe to. */
export const WEBHOOK_EVENTS = [
  { value: 'reservation.created', label: 'Reservation created' },
  { value: 'reservation.confirmed', label: 'Reservation confirmed' },
  { value: 'reservation.updated', label: 'Reservation updated (dates, details, room, check-in/out)' },
  { value: 'reservation.cancelled', label: 'Reservation cancelled' },
  { value: 'payment.succeeded', label: 'Payment succeeded' },
  { value: 'payment.failed', label: 'Payment failed' },
  { value: 'inventory.updated', label: 'Inventory or restrictions changed' },
] as const;

export interface ApiKey {
  _id: string;
  name: string;
  keyPrefix: string;
  scopes: string[];
  propertyIds: string[];
  status: 'ACTIVE' | 'REVOKED';
  expiresAt: string | null;
  lastUsedAt: string | null;
  lastUsedIp?: string | null;
  /** Where the key was issued: production, staging, development. */
  environment?: string;
  rotatedFrom?: string | null;
  createdAt: string;
}

export interface CreatedApiKey extends ApiKey {
  /** The full key. Returned once, at creation and after rotation. */
  key: string;
}

export interface WebhookEndpoint {
  _id: string;
  url: string;
  description?: string;
  events: string[];
  propertyIds: string[];
  status: 'ACTIVE' | 'DISABLED';
  /** false: payloads carry the guest as first name + last initial only. */
  includeGuestDetails?: boolean;
  createdAt: string;
}

export interface WebhookEndpointWithSecret extends WebhookEndpoint {
  /** The signing secret. Returned once, at creation and after rotation. */
  secret: string;
}

export interface WebhookDelivery {
  _id: string;
  eventId: string;
  eventType: string;
  status: 'PENDING' | 'RETRYING' | 'DELIVERED' | 'FAILED';
  attempts: number;
  lastStatusCode?: number;
  lastError?: string;
  deliveredAt?: string;
  createdAt: string;
}

export interface DeveloperOverview {
  apiKeys: { active: number; revoked: number };
  webhookEndpoints: { active: number; disabled: number };
  deliveriesLast24h: { total: number; delivered: number; pending: number; failed: number };
  endpointsWithProblems: { endpointId: string; url: string; failedLast24h: number; lastError: string | null }[];
  apiUsageLast7Days: { requests: number; clientErrors: number; serverErrors: number; rateLimited: number };
}

export interface KeyUsageDay {
  day: string;
  requests: number;
  clientErrors: number;
  serverErrors: number;
  rateLimited: number;
}

export interface DeveloperProperty {
  _id: string;
  name: string;
  slug: string;
  status: string;
}

const json = (body: unknown) => JSON.stringify(body);

export const developerApi = {
  overview: () => apiClient<DeveloperOverview>('/developer/overview'),
  properties: () => apiClient<DeveloperProperty[]>('/developer/properties'),

  listKeys: () => apiClient<ApiKey[]>('/api-keys'),
  createKey: (body: { name: string; scopes: string[]; propertyIds?: string[]; expiresAt?: string }) => apiClient<CreatedApiKey>('/api-keys', { method: 'POST', body: json(body) }),
  revokeKey: (id: string) => apiClient<ApiKey>(`/api-keys/${id}`, { method: 'DELETE' }),
  rotateKey: (id: string, graceHours?: number) => apiClient<CreatedApiKey>(`/api-keys/${id}/rotate`, { method: 'POST', body: json(graceHours ? { graceHours } : {}) }),
  keyUsage: (id: string) => apiClient<{ days: KeyUsageDay[] }>(`/api-keys/${id}/usage`),

  listEndpoints: () => apiClient<WebhookEndpoint[]>('/webhook-endpoints'),
  createEndpoint: (body: { url: string; events: string[]; description?: string; includeGuestDetails?: boolean; propertyIds?: string[] }) => apiClient<WebhookEndpointWithSecret>('/webhook-endpoints', { method: 'POST', body: json(body) }),
  setEndpointStatus: (id: string, status: 'ACTIVE' | 'DISABLED') => apiClient<WebhookEndpoint>(`/webhook-endpoints/${id}`, { method: 'PATCH', body: json({ status }) }),
  setGuestDetails: (id: string, includeGuestDetails: boolean) => apiClient<WebhookEndpoint>(`/webhook-endpoints/${id}`, { method: 'PATCH', body: json({ includeGuestDetails }) }),
  deleteEndpoint: (id: string) => apiClient<{ ok: boolean }>(`/webhook-endpoints/${id}`, { method: 'DELETE' }),
  rotateSecret: (id: string) => apiClient<WebhookEndpointWithSecret>(`/webhook-endpoints/${id}/rotate-secret`, { method: 'POST' }),
  sendTest: (id: string) => apiClient<{ deliveryId: string; eventId: string }>(`/webhook-endpoints/${id}/test`, { method: 'POST' }),
  deliveries: (id: string) => apiClient<{ items: WebhookDelivery[]; total: number }>(`/webhook-endpoints/${id}/deliveries`, { params: { limit: 25 } }),
  redeliver: (endpointId: string, deliveryId: string) => apiClient<WebhookDelivery>(`/webhook-endpoints/${endpointId}/deliveries/${deliveryId}/redeliver`, { method: 'POST' }),
};
