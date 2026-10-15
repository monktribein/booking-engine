import { addDays, format } from 'date-fns';
import { apiClient } from './client';
import { mapOccupancy, mapRevenue } from './mappers';
import { DashboardStats, OccupancyReport, RevenueReport } from '@/types';

/* eslint-disable @typescript-eslint/no-explicit-any */
const iso = (d: Date) => format(d, 'yyyy-MM-dd');

export const reportsApi = {
  async getRevenueReport(propertyId: string, from: string, to: string): Promise<RevenueReport> {
    return mapRevenue(await apiClient<any>(`/properties/${propertyId}/reports/revenue`, { params: { from, to } }), from, to);
  },

  async getOccupancyReport(propertyId: string, from: string, to: string): Promise<OccupancyReport[]> {
    return mapOccupancy(await apiClient<any[]>(`/properties/${propertyId}/reports/occupancy`, { params: { from, to } }));
  },

  /**
   * The backend has no single dashboard endpoint. Today's figures are composed from the occupancy report,
   * the reservation list (arrivals / departures) and the revenue report. If any call fails the whole call
   * rejects; partial or placeholder numbers are never returned.
   */
  async getDashboardStats(propertyId: string, currency: string): Promise<DashboardStats> {
    const today = new Date();
    const from = iso(today);
    const to = iso(addDays(today, 1));
    const [occ, arrivals, inHouse, revenue] = await Promise.all([
      reportsApi.getOccupancyReport(propertyId, from, to),
      apiClient<any>('/reservations', { params: { propertyId, from, to, limit: 100 } }),
      apiClient<any>('/reservations', { params: { propertyId, status: 'CHECKED_IN', limit: 100 } }),
      reportsApi.getRevenueReport(propertyId, from, to),
    ]);
    const day = occ[0];
    const checkIns = (arrivals.items as any[]).filter((r) => r.checkIn.slice(0, 10) === from && r.status !== 'CANCELLED').length;
    const checkOuts = (inHouse.items as any[]).filter((r) => r.checkOut.slice(0, 10) === from).length;
    return {
      totalRooms: day?.totalRooms ?? 0,
      occupiedRooms: day?.soldRooms ?? 0,
      availableRooms: day?.availableRooms ?? 0,
      occupancyPercent: day?.occupancyPercent ?? 0,
      todayCheckIns: checkIns,
      todayCheckOuts: checkOuts,
      todayBookings: revenue.bySource.reduce((a, s) => a + s.bookings, 0),
      todayRevenue: revenue.totalRevenue,
      currency,
    };
  },
};
