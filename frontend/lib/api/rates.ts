import { apiClient } from './client';
import { mapPromotion, mapRatePlan, promotionBody, ratePlanBody } from './mappers';
import { Promotion, RateCalendarDay, RatePlan, RateRule } from '@/types';

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

  listRateRules(propertyId: string, roomTypeId?: string): Promise<RateRule[]> {
    return apiClient<RateRule[]>(`/properties/${propertyId}/rate-rules`, { params: roomTypeId ? { roomTypeId } : {} });
  },

  createRateRule(propertyId: string, body: Record<string, unknown>): Promise<RateRule> {
    return apiClient<RateRule>(`/properties/${propertyId}/rate-rules`, { method: 'POST', body: JSON.stringify(body) });
  },

  updateRateRule(id: string, body: Record<string, unknown>): Promise<RateRule> {
    return apiClient<RateRule>(`/rate-rules/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
  },

  deactivateRateRule(id: string): Promise<RateRule> {
    return apiClient<RateRule>(`/rate-rules/${id}`, { method: 'DELETE' });
  },

  rateCalendar(propertyId: string, params: { roomTypeId: string; ratePlanId?: string; from: string; to: string }): Promise<RateCalendarDay[]> {
    return apiClient<RateCalendarDay[]>(`/properties/${propertyId}/rate-calendar`, { params });
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
