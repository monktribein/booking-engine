import { apiClient } from './client';
import { mapAvailability, mapPublicBookingResult, mapPublicProperty, mapPublicReservationView } from './mappers';
import { PublicAvailabilityItem, PublicBookingInput, PublicBookingResult, PublicPropertyData, PublicPropertySearchParams, PublicPropertySearchResult, PublicReservationView } from '@/types';

/* eslint-disable @typescript-eslint/no-explicit-any */
export const bookingEngineApi = {
  /** Cross-property search for the guest site. With dates, only properties that can host the stay are returned. */
  searchProperties({ amenities, ...params }: PublicPropertySearchParams): Promise<PublicPropertySearchResult> {
    return apiClient<PublicPropertySearchResult>('/public/properties', {
      params: { ...params, amenities: amenities?.length ? amenities.join(',') : undefined, limit: 12 },
      skipAuth: true,
    });
  },

  async getPublicProperty(slug: string): Promise<PublicPropertyData> {
    return mapPublicProperty(await apiClient<any>(`/public/properties/${slug}`, { skipAuth: true }));
  },

  async searchAvailability(
    slug: string,
    params: { checkIn: string; checkOut: string; adults: number; children?: number; rooms?: number; promoCode?: string },
    property?: Pick<PublicPropertyData, 'roomTypes'>
  ): Promise<PublicAvailabilityItem[]> {
    const raw = await apiClient<any[]>(`/public/properties/${slug}/availability`, { params, skipAuth: true });
    return mapAvailability(raw, property);
  },

  /**
   * Creates the booking. `idempotencyKey` must be generated once per checkout attempt and reused on retries,
   * so a double click or a network retry can never create a second reservation.
   */
  async createBooking(input: PublicBookingInput, idempotencyKey: string): Promise<PublicBookingResult> {
    const raw = await apiClient<any>('/public/reservations', {
      method: 'POST',
      body: JSON.stringify({
        propertySlug: input.propertySlug,
        source: input.source,
        checkIn: input.checkIn,
        checkOut: input.checkOut,
        adults: input.adults,
        children: input.children,
        rooms: [{ roomTypeId: input.roomTypeId, ratePlanId: input.ratePlanId, quantity: input.quantity }],
        guest: input.guest,
        promoCode: input.promoCode || undefined,
        expectedTotal: input.expectedTotal,
        specialRequests: input.specialRequests || undefined,
      }),
      headers: { 'Idempotency-Key': idempotencyKey },
      skipAuth: true,
    });
    return mapPublicBookingResult(raw);
  },

  /** Guest cancels their own booking; the refund follows the policy frozen on the booking. */
  async cancelReservation(code: string, email: string): Promise<PublicReservationView> {
    const raw = await apiClient<any>(`/public/reservations/${encodeURIComponent(code)}/cancel`, { method: 'POST', body: JSON.stringify({ email }), skipAuth: true });
    return mapPublicReservationView(raw.reservation);
  },

  async lookupReservation(code: string, email: string): Promise<PublicReservationView> {
    return mapPublicReservationView(
      await apiClient<any>(`/public/reservations/${encodeURIComponent(code)}`, { params: { email }, skipAuth: true })
    );
  },
};
