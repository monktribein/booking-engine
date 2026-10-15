import { apiClient } from './client';
import { mapPage } from './mappers';
import { Guest, PaginatedResult } from '@/types';

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface GuestListParams {
  propertyId: string;
  search?: string;
  page?: number;
  limit?: number;
}

export const guestsApi = {
  async list({ search, ...params }: GuestListParams): Promise<PaginatedResult<Guest>> {
    // The backend's search query parameter is `q`.
    return mapPage(await apiClient<any>('/guests', { params: { ...params, q: search } }), (g: Guest) => g);
  },

  get(id: string): Promise<Guest> {
    return apiClient<Guest>(`/guests/${id}`);
  },

  create(payload: Partial<Guest> & { propertyId: string }): Promise<Guest> {
    return apiClient<Guest>('/guests', { method: 'POST', body: JSON.stringify(payload) });
  },

  update(id: string, payload: Partial<Guest>): Promise<Guest> {
    return apiClient<Guest>(`/guests/${id}`, { method: 'PATCH', body: JSON.stringify(payload) });
  },
};
