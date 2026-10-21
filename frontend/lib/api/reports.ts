import { apiClient } from './client';
import { mapOccupancy, mapRevenue } from './mappers';
import { DashboardStats, OccupancyReport, RevenueReport } from '@/types';

/* eslint-disable @typescript-eslint/no-explicit-any */

export const reportsApi = {
  async getRevenueReport(propertyId: string, from: string, to: string): Promise<RevenueReport> {
    return mapRevenue(await apiClient<any>(`/properties/${propertyId}/reports/revenue`, { params: { from, to } }), from, to);
  },

  async getOccupancyReport(propertyId: string, from: string, to: string): Promise<OccupancyReport[]> {
    return mapOccupancy(await apiClient<any[]>(`/properties/${propertyId}/reports/occupancy`, { params: { from, to } }));
  },

  /**
   * One server-computed snapshot. Without `date` the server uses today in the property's own time zone (never the
   * browser's), so the day boundary is the front desk's. A failure rejects; no placeholder numbers are returned.
   */
  getDashboardStats(propertyId: string, date?: string): Promise<DashboardStats> {
    return apiClient<DashboardStats>(`/properties/${propertyId}/reports/dashboard`, { params: date ? { date } : {} });
  },
};
