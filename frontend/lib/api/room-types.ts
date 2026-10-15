import { apiClient } from './client';
import { RoomType } from '@/types';

export const roomTypesApi = {
  list(propertyId: string): Promise<RoomType[]> {
    return apiClient<RoomType[]>(`/properties/${propertyId}/room-types`);
  },

  get(id: string): Promise<RoomType> {
    return apiClient<RoomType>(`/room-types/${id}`);
  },

  create(propertyId: string, payload: Partial<RoomType>): Promise<RoomType> {
    return apiClient<RoomType>(`/properties/${propertyId}/room-types`, { method: 'POST', body: JSON.stringify(payload) });
  },

  update(id: string, payload: Partial<RoomType>): Promise<RoomType> {
    return apiClient<RoomType>(`/room-types/${id}`, { method: 'PATCH', body: JSON.stringify(payload) });
  },

  archive(id: string): Promise<RoomType> {
    return apiClient<RoomType>(`/room-types/${id}`, { method: 'DELETE' });
  },
};
