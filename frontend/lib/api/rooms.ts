import { apiClient } from './client';
import { mapRoom } from './mappers';
import { PhysicalRoom, RoomStatus, RoomType } from '@/types';

/* eslint-disable @typescript-eslint/no-explicit-any */
export const roomsApi = {
  async listByRoomType(roomTypeId: string): Promise<PhysicalRoom[]> {
    return (await apiClient<any[]>(`/room-types/${roomTypeId}/rooms`)).map(mapRoom);
  },

  /**
   * The backend has no "all rooms of a property" endpoint, so this composes the two existing ones.
   * If any request fails the whole call rejects: a partial list is never returned as if it were complete.
   */
  async listAll(propertyId: string): Promise<PhysicalRoom[]> {
    const roomTypes = await apiClient<RoomType[]>(`/properties/${propertyId}/room-types`);
    const perType = await Promise.all(roomTypes.map((rt) => roomsApi.listByRoomType(rt._id)));
    return perType.flat();
  },

  async get(id: string): Promise<PhysicalRoom> {
    return mapRoom(await apiClient<any>(`/rooms/${id}`));
  },

  async create(roomTypeId: string, payload: { roomNumber: string; floor?: string; notes?: string }): Promise<PhysicalRoom> {
    return mapRoom(await apiClient<any>(`/room-types/${roomTypeId}/rooms`, { method: 'POST', body: JSON.stringify(payload) }));
  },

  async update(id: string, payload: { roomNumber?: string; floor?: string; notes?: string }): Promise<PhysicalRoom> {
    return mapRoom(await apiClient<any>(`/rooms/${id}`, { method: 'PATCH', body: JSON.stringify(payload) }));
  },

  /** Backend body: { status, blockUntil?, notes? }. The server creates the inventory block when a room goes out of service. */
  async changeStatus(
    id: string,
    payload: { status: RoomStatus; blockUntil?: string; notes?: string }
  ): Promise<{ room: PhysicalRoom; inventoryBlockId?: string | null }> {
    const res = await apiClient<any>(`/rooms/${id}/status`, { method: 'POST', body: JSON.stringify(payload) });
    return { room: mapRoom(res.room), inventoryBlockId: res.inventoryBlockId ?? null };
  },
};
