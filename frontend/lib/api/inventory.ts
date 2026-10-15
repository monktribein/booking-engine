import { apiClient } from './client';
import { mapBlock, mapCalendar } from './mappers';
import { InventoryBlock, InventoryCalendarResult } from '@/types';

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface SetRestrictionsPayload {
  roomTypeId: string;
  from: string;
  to: string;
  stopSell?: boolean;
  closedToArrival?: boolean;
  closedToDeparture?: boolean;
  minimumStay?: number;
  maximumStay?: number;
}

export interface CreateBlockPayload {
  propertyId: string;
  roomTypeId: string;
  roomId?: string | null;
  startDate: string;
  endDate: string;
  quantity?: number;
  reason: string;
  notes?: string;
}

export const inventoryApi = {
  async getCalendar(propertyId: string, from: string, to: string): Promise<InventoryCalendarResult> {
    return mapCalendar(propertyId, await apiClient<any>(`/properties/${propertyId}/inventory`, { params: { from, to } }));
  },

  async setRestrictions(propertyId: string, payload: SetRestrictionsPayload): Promise<{ ok: boolean }> {
    await apiClient<unknown>(`/properties/${propertyId}/restrictions`, { method: 'PUT', body: JSON.stringify(payload) });
    return { ok: true };
  },

  async createBlock({ roomId, ...payload }: CreateBlockPayload): Promise<InventoryBlock> {
    const body = roomId ? { ...payload, roomId } : payload;
    return mapBlock(await apiClient<any>('/inventory/block', { method: 'POST', body: JSON.stringify(body) }));
  },

  async unblock(blockId: string): Promise<InventoryBlock> {
    return mapBlock(await apiClient<any>(`/inventory/block/${blockId}`, { method: 'DELETE' }));
  },
};
