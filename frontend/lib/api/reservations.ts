import { apiClient } from './client';
import { mapPage, mapReservation } from './mappers';
import { PaginatedResult, Reservation, ReservationStatus } from '@/types';

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface ReservationFilterParams {
  propertyId: string;
  /** Booking source (backend query param `source`). */
  channel?: string;
  status?: ReservationStatus;
  from?: string;
  to?: string;
  /** Code, guest name, e-mail or phone (backend query param `q`). */
  search?: string;
  page?: number;
  limit?: number;
}

export interface CreateReservationPayload {
  propertyId: string;
  guest: {
    firstName: string;
    lastName: string;
    email?: string;
    phone?: string;
    country?: string;
  };
  checkIn: string;
  checkOut: string;
  adults: number;
  children?: number;
  rooms: {
    roomTypeId: string;
    ratePlanId: string;
    quantity: number;
  }[];
  source?: string;
  specialRequests?: string;
}

export const reservationsApi = {
  async list({ channel, search, ...rest }: ReservationFilterParams): Promise<PaginatedResult<Reservation>> {
    const raw = await apiClient<any>('/reservations', { params: { ...rest, source: channel, q: search } });
    return mapPage(raw, mapReservation);
  },

  async get(id: string): Promise<Reservation> {
    return mapReservation(await apiClient<any>(`/reservations/${id}`));
  },

  async create(payload: CreateReservationPayload): Promise<Reservation> {
    return mapReservation(await apiClient<any>('/reservations', { method: 'POST', body: JSON.stringify(payload) }));
  },

  /** Backend allows editing dates, party size, special requests and the guest snapshot only. */
  async update(
    id: string,
    payload: { checkIn?: string; checkOut?: string; adults?: number; children?: number; specialRequests?: string; guest?: CreateReservationPayload['guest'] }
  ): Promise<Reservation> {
    return mapReservation(await apiClient<any>(`/reservations/${id}`, { method: 'PATCH', body: JSON.stringify(payload) }));
  },

  async cancel(id: string, reason: string): Promise<{ reservation: Reservation; refundIssued: boolean; alreadyCancelled: boolean }> {
    const res = await apiClient<any>(`/reservations/${id}/cancel`, { method: 'POST', body: JSON.stringify({ reason }) });
    return { reservation: mapReservation(res.reservation), refundIssued: (res.refunds ?? []).length > 0, alreadyCancelled: !!res.alreadyCancelled };
  },

  async checkIn(id: string, assignments?: { reservationRoomId: string; roomId: string }[]): Promise<Reservation> {
    return mapReservation(await apiClient<any>(`/reservations/${id}/check-in`, { method: 'POST', body: JSON.stringify(assignments ? { assignments } : {}) }));
  },

  async checkOut(id: string): Promise<{ reservation: Reservation; balanceDue: number }> {
    const res = await apiClient<any>(`/reservations/${id}/check-out`, { method: 'POST' });
    return { reservation: mapReservation(res.reservation), balanceDue: res.balanceDue };
  },

  async noShow(id: string): Promise<Reservation> {
    return mapReservation(await apiClient<any>(`/reservations/${id}/no-show`, { method: 'POST' }));
  },

  async assignRoom(reservationId: string, reservationRoomId: string, roomId: string): Promise<Reservation> {
    return mapReservation(
      await apiClient<any>(`/reservations/${reservationId}/assign-room`, { method: 'POST', body: JSON.stringify({ reservationRoomId, roomId }) })
    );
  },
};
