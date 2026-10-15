import { apiClient } from './client';
import { mapPromotion, mapRatePlan, promotionBody, ratePlanBody } from './mappers';
import { Promotion, RatePlan } from '@/types';

/* eslint-disable @typescript-eslint/no-explicit-any */
export const ratesApi = {
  async listRatePlans(propertyId: string, roomTypeId?: string): Promise<RatePlan[]> {
    const all = (await apiClient<any[]>(`/properties/${propertyId}/rate-plans`)).map(mapRatePlan);
    // The endpoint has no roomTypeId filter, so filter here.
    return roomTypeId ? all.filter((r) => r.roomTypeId === roomTypeId) : all;
  },

  async createRatePlan(propertyId: string, payload: Partial<RatePlan>): Promise<RatePlan> {
    return mapRatePlan(
      await apiClient<any>(`/properties/${propertyId}/rate-plans`, { method: 'POST', body: JSON.stringify(ratePlanBody(payload, 'create')) })
    );
  },

  async updateRatePlan(id: string, payload: Partial<RatePlan>): Promise<RatePlan> {
    return mapRatePlan(await apiClient<any>(`/rate-plans/${id}`, { method: 'PATCH', body: JSON.stringify(ratePlanBody(payload, 'update')) }));
  },

  async archiveRatePlan(id: string): Promise<RatePlan> {
    return mapRatePlan(await apiClient<any>(`/rate-plans/${id}`, { method: 'DELETE' }));
  },

  async listPromotions(propertyId: string): Promise<Promotion[]> {
    return (await apiClient<any[]>(`/properties/${propertyId}/promotions`)).map(mapPromotion);
  },

  async createPromotion(propertyId: string, payload: Partial<Promotion>): Promise<Promotion> {
    return mapPromotion(
      await apiClient<any>(`/properties/${propertyId}/promotions`, { method: 'POST', body: JSON.stringify(promotionBody(payload)) })
    );
  },
};
