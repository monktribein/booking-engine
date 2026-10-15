import { apiClient } from './client';
import { mapChannel, mapListing } from './mappers';
import { ChannelListing, ChannelStatusInfo, PaginatedResult } from '@/types';

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface SyncJobItem {
  _id: string;
  propertyId: string;
  channel: string;
  type: string;
  entityType: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  lastError?: string;
  startedAt?: string;
  completedAt?: string;
  updatedAt: string;
}

/** GET /admin/sync-errors (platform admins only). */
export interface SyncErrorsResult {
  syncJobs: PaginatedResult<SyncJobItem>;
  recentFailures: { _id: string; channel: string; action?: string; error?: string; createdAt: string }[];
  failedWebhooks: { _id: string; channel: string; eventType?: string; lastError?: string; updatedAt: string }[];
}

/** Backend contract (POST .../mappings): one entry per mapped external room. */
export interface SaveMappingsPayload {
  mappings: {
    externalListingId: string;
    externalRoomId?: string;
    roomTypeId: string;
    syncAvailability?: boolean;
    syncRates?: boolean;
    syncRestrictions?: boolean;
    ratePlans?: {
      externalRatePlanId: string;
      ratePlanId: string;
      markupType?: string;
      markupValue?: number;
    }[];
  }[];
}

export const channelsApi = {
  async list(propertyId: string): Promise<ChannelStatusInfo[]> {
    return (await apiClient<any[]>(`/properties/${propertyId}/channels`)).map(mapChannel);
  },

  /** Returns the channel's real authorization URL. A failure rejects; no URL is ever invented. */
  connect(propertyId: string, channel: string): Promise<{ status: string; authorizationUrl?: string }> {
    return apiClient(`/properties/${propertyId}/channels/${channel}/connect`, { method: 'POST' });
  },

  disconnect(propertyId: string, channel: string): Promise<{ status: string }> {
    return apiClient(`/properties/${propertyId}/channels/${channel}/disconnect`, { method: 'POST' });
  },

  async getListings(propertyId: string, channel: string, refresh: boolean = true): Promise<ChannelListing[]> {
    const raw = await apiClient<any[]>(`/properties/${propertyId}/channels/${channel}/listings`, { params: { refresh } });
    return raw.map((l) => mapListing(propertyId, channel, l));
  },

  saveMappings(propertyId: string, channel: string, payload: SaveMappingsPayload) {
    return apiClient<{ mappingId: string; created: boolean }[]>(`/properties/${propertyId}/channels/${channel}/mappings`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  removeMapping(propertyId: string, channel: string, mappingId: string): Promise<{ ok: boolean }> {
    return apiClient<{ ok: boolean }>(`/properties/${propertyId}/channels/${channel}/mappings/${mappingId}`, { method: 'DELETE' });
  },

  /** Backend queues sync jobs and answers { queued: n }. */
  triggerSync(propertyId: string, channel: string): Promise<{ queued: number }> {
    return apiClient<{ queued: number }>(`/properties/${propertyId}/channels/${channel}/sync`, { method: 'POST' });
  },

  /** Platform-admin only on the backend (GET /admin/sync-errors); other roles get a 403 ApiError. */
  getSyncErrors(): Promise<SyncErrorsResult> {
    return apiClient<SyncErrorsResult>('/admin/sync-errors');
  },

  retrySyncJob(id: string): Promise<{ ok: boolean }> {
    return apiClient<{ ok: boolean }>(`/admin/sync-jobs/${id}/retry`, { method: 'POST' });
  },
};
