import { apiClient } from './client';

/** Scopes an API key can hold (must match the backend's API_SCOPES). */
export const API_SCOPES = [
  { value: 'properties:read', label: 'Read properties' },
  { value: 'availability:read', label: 'Search availability' },
  { value: 'reservations:read', label: 'Read reservations' },
  { value: 'reservations:write', label: 'Create and cancel reservations' },
] as const;

/** Event types a webhook endpoint can subscribe to. */
export const WEBHOOK_EVENTS = [
  { value: 'reservation.created', label: 'Reservation created' },
  { value: 'reservation.confirmed', label: 'Reservation confirmed' },
  { value: 'reservation.cancelled', label: 'Reservation cancelled' },
  { value: 'payment.succeeded', label: 'Payment succeeded' },
  { value: 'payment.failed', label: 'Payment failed' },
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
  createdAt: string;
}

export interface CreatedApiKey extends ApiKey {
  /** The full key. Returned once, at creation. */
  key: string;
}

export interface WebhookEndpoint {
  _id: string;
  url: string;
  description?: string;
  events: string[];
  propertyIds: string[];
  status: 'ACTIVE' | 'DISABLED';
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

const json = (body: unknown) => JSON.stringify(body);

export const developerApi = {
  listKeys: () => apiClient<ApiKey[]>('/api-keys'),
  createKey: (body: { name: string; scopes: string[] }) => apiClient<CreatedApiKey>('/api-keys', { method: 'POST', body: json(body) }),
  revokeKey: (id: string) => apiClient<ApiKey>(`/api-keys/${id}`, { method: 'DELETE' }),

  listEndpoints: () => apiClient<WebhookEndpoint[]>('/webhook-endpoints'),
  createEndpoint: (body: { url: string; events: string[]; description?: string }) => apiClient<WebhookEndpointWithSecret>('/webhook-endpoints', { method: 'POST', body: json(body) }),
  setEndpointStatus: (id: string, status: 'ACTIVE' | 'DISABLED') => apiClient<WebhookEndpoint>(`/webhook-endpoints/${id}`, { method: 'PATCH', body: json({ status }) }),
  deleteEndpoint: (id: string) => apiClient<{ ok: boolean }>(`/webhook-endpoints/${id}`, { method: 'DELETE' }),
  rotateSecret: (id: string) => apiClient<WebhookEndpointWithSecret>(`/webhook-endpoints/${id}/rotate-secret`, { method: 'POST' }),
  sendTest: (id: string) => apiClient<{ deliveryId: string; eventId: string }>(`/webhook-endpoints/${id}/test`, { method: 'POST' }),
  deliveries: (id: string) => apiClient<{ items: WebhookDelivery[]; total: number }>(`/webhook-endpoints/${id}/deliveries`, { params: { limit: 25 } }),
  redeliver: (endpointId: string, deliveryId: string) => apiClient<WebhookDelivery>(`/webhook-endpoints/${endpointId}/deliveries/${deliveryId}/redeliver`, { method: 'POST' }),
};
