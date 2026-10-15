/* eslint-disable @typescript-eslint/no-explicit-any */
import { apiClient } from './client';
import { mapPage } from './mappers';
import { PaginatedResult, Property } from '@/types';

export const propertiesApi = {
  async list(): Promise<PaginatedResult<Property>> {
    return mapPage(await apiClient<any>('/properties'), (p: Property) => p);
  },

  get(id: string): Promise<Property> {
    return apiClient<Property>(`/properties/${id}`);
  },

  create(payload: Partial<Property>): Promise<Property> {
    return apiClient<Property>('/properties', { method: 'POST', body: JSON.stringify(payload) });
  },

  update(id: string, payload: Partial<Property>): Promise<Property> {
    return apiClient<Property>(`/properties/${id}`, { method: 'PATCH', body: JSON.stringify(payload) });
  },

  archive(id: string): Promise<Property> {
    return apiClient<Property>(`/properties/${id}`, { method: 'DELETE' });
  },
};
