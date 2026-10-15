import {
  ChannelCode,
  ChannelConnectionStatus,
  ChannelKind,
  ChannelListingStatus,
  InventoryBlockReason,
  InventoryBlockStatus,
  MarkupType,
  MealPlan,
  PaymentProvider,
  PaymentStatus,
  PropertyStatus,
  PropertyUserRole,
  RatePlanType,
  ReservationPaymentStatus,
  ReservationSource,
  ReservationStatus,
  RoomStatus,
  RoomTypeStatus,
  UserRole,
  UserStatus,
} from './enums';

export * from './enums';

// ---------------------------------------------------------------- API Envelope
export interface ApiResponse<T> {
  success: true;
  data: T;
}

export interface ApiErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export interface PaginatedResult<T> {
  items: T[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

// ---------------------------------------------------------------- Auth & User
export interface User {
  _id: string;
  organizationId: string;
  name: string;
  email: string;
  phone?: string;
  role: UserRole;
  status: UserStatus;
  createdAt: string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
}

export interface PropertyUser {
  _id: string;
  propertyId: string;
  userId: string;
  role: PropertyUserRole;
  user?: User;
}

// ---------------------------------------------------------------- Property
export interface PropertyImage {
  url: string;
  caption?: string;
  sortOrder?: number;
}

export interface Property {
  _id: string;
  organizationId: string;
  ownerId: string;
  name: string;
  slug: string;
  description: string;
  address: string;
  city: string;
  state: string;
  country: string;
  postalCode?: string;
  latitude?: number;
  longitude?: number;
  phone?: string;
  email?: string;
  currency: string;
  timezone: string;
  checkInTime: string;
  checkOutTime: string;
  taxPercent: number;
  bookingHorizonDays: number;
  amenities: string[];
  images: PropertyImage[];
  status: PropertyStatus;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------- Room Type
export interface RoomType {
  _id: string;
  propertyId: string;
  name: string;
  slug: string;
  description?: string;
  maxOccupancy: number;
  basePrice: number; // in minor units (paise)
  currency: string;
  totalRooms: number;
  amenities: string[];
  images?: PropertyImage[];
  status: RoomTypeStatus;
  sortOrder?: number;
  availableCount?: number;
}

// ---------------------------------------------------------------- Physical Room
export interface PhysicalRoom {
  _id: string;
  propertyId: string;
  roomTypeId: string;
  roomNumber: string;
  floor?: string;
  status: RoomStatus;
  currentReservationId?: string | null;
  cleaningNotes?: string;
  updatedAt?: string;
}

// ---------------------------------------------------------------- Rate Plan & Restrictions
export interface RatePlan {
  _id: string;
  propertyId: string;
  roomTypeId: string;
  code: string;
  name: string;
  type: RatePlanType;
  basePrice: number; // minor units
  currency: string;
  mealPlan: MealPlan;
  cancellationPolicy: {
    refundable: boolean;
    freeCancellationHours?: number;
    penaltyType: string;
    penaltyValue?: number;
    description?: string;
  };
  isActive?: boolean;
}

export interface Promotion {
  _id: string;
  propertyId: string;
  code: string;
  description?: string;
  discountPercent: number;
  validFrom: string;
  validTo: string;
  isActive: boolean;
}

// ---------------------------------------------------------------- Inventory & Calendar
export interface InventoryDay {
  date: string;
  total: number;
  sold: number;
  blocked: number;
  available: number;
  stopSell: boolean;
  closedToArrival: boolean;
  closedToDeparture: boolean;
  minimumStay: number;
  maximumStay?: number;
}

export interface RoomTypeCalendar {
  roomTypeId: string;
  roomTypeName: string;
  days: InventoryDay[];
}

export interface InventoryCalendarResult {
  propertyId: string;
  from: string;
  to: string;
  roomTypes: RoomTypeCalendar[];
  blocks?: InventoryBlock[];
  reservations?: ReservationCalendarItem[];
}

export interface InventoryBlock {
  _id: string;
  propertyId: string;
  roomTypeId: string;
  roomId?: string | null;
  startDate: string;
  endDate: string;
  quantity: number;
  reason: InventoryBlockReason;
  status: InventoryBlockStatus;
  notes?: string;
  createdBy?: string;
}

export interface ReservationCalendarItem {
  reservationId: string;
  code: string;
  guestName: string;
  channel: ReservationSource;
  /** One entry per booked room line; roomId is null until a physical room is assigned. */
  rooms: { roomTypeId: string; roomId: string | null; roomNumber?: string }[];
  checkIn: string;
  checkOut: string;
  status: ReservationStatus;
}

// ---------------------------------------------------------------- Reservation & Guest
export interface Guest {
  _id: string;
  propertyId: string;
  firstName: string;
  lastName: string;
  email?: string;
  phone?: string;
  country?: string;
  documentType?: string;
  notes?: string;
  totalBookings?: number;
  totalSpend?: number;
  upcomingStays?: Reservation[];
  pastStays?: Reservation[];
}

export interface ReservationRoom {
  _id: string;
  roomTypeId: string;
  roomTypeName?: string;
  ratePlanId: string;
  ratePlanName?: string;
  roomId?: string | null;
  roomNumber?: string;
  quantity?: number;
  nightlyPrice: number;
  nights: number;
  total: number;
}

export interface ReservationTimelineEvent {
  action: string;
  actor: string;
  timestamp: string;
  details?: string;
}

export interface Reservation {
  _id: string;
  propertyId: string;
  code: string; // e.g. TRV-123456
  source: ReservationSource;
  status: ReservationStatus;
  paymentStatus: ReservationPaymentStatus;
  guest: Guest;
  checkIn: string;
  checkOut: string;
  adults: number;
  children?: number;
  rooms: ReservationRoom[];
  subtotal: number;
  taxAmount: number;
  discountAmount: number;
  total: number;
  currency: string;
  channelReservationId?: string;
  amountPaid?: number;
  amountRefunded?: number;
  /** ISO time until which a PENDING booking holds its rooms. */
  holdExpiresAt?: string;
  /** Only present on the public lookup view. */
  propertyName?: string;
  notes?: string;
  specialRequests?: string;
  timeline?: ReservationTimelineEvent[];
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------- Payments
export interface Payment {
  _id: string;
  propertyId: string;
  reservationId: string;
  reservationCode?: string;
  guestName?: string;
  amount: number;
  currency: string;
  provider: PaymentProvider;
  status: PaymentStatus;
  providerPaymentId?: string;
  providerOrderId?: string;
  refunds?: RefundItem[];
  createdAt?: string;
  paidAt?: string;
  amountRefunded?: number;
}

export interface RefundItem {
  _id: string;
  amount: number;
  reason: string;
  status: string;
  createdAt: string;
}

// ---------------------------------------------------------------- Channel Manager
export interface ChannelStatusInfo {
  channel: ChannelCode;
  name: string;
  kind: ChannelKind;
  status: ChannelConnectionStatus;
  connectedAt?: string;
  lastSyncAt?: string;
  lastSyncStatus?: 'SUCCESS' | 'FAILED';
  lastError?: string;
  externalAccountId?: string;
  listingsCount?: number;
  mappedCount?: number;
  /** true for Tirvona / Direct: always available, never connected through OAuth. */
  internal?: boolean;
  /** false until the OTA adapter exists (partner API access required). */
  available?: boolean;
}

export interface ChannelListing {
  _id: string;
  propertyId: string;
  channel: ChannelCode;
  externalListingId: string;
  name: string;
  channelConnectionId?: string;
  status: ChannelListingStatus;
  metadata?: Record<string, unknown>;
  externalRooms?: { externalRoomId: string; name: string }[];
  externalRatePlans?: { externalRatePlanId: string; name: string; externalRoomId?: string | null }[];
  roomMappings?: ChannelRoomMapping[];
}

/** One mapping per external room (or per single-unit listing, where externalRoomId is null). */
export interface ChannelRoomMapping {
  _id: string;
  externalRoomId?: string | null;
  roomTypeId: string;
  roomTypeName?: string;
  status: string;
  syncAvailability?: boolean;
  syncRates?: boolean;
  syncRestrictions?: boolean;
  rateMappings?: ChannelRatePlanMapping[];
}

export interface ChannelRatePlanMapping {
  _id: string;
  externalRatePlanId: string;
  ratePlanId: string;
  markupType: MarkupType;
  /** Percent for PERCENTAGE, minor units for FIXED. */
  markupValue: number;
  status?: string;
}

export interface SyncLog {
  _id: string;
  propertyId: string;
  channel: ChannelCode;
  action: string;
  entity: string;
  status: 'SUCCESS' | 'FAILED';
  startedAt: string;
  completedAt?: string;
  error?: string;
  retryCount?: number;
}

// ---------------------------------------------------------------- Reports & Stats
export interface DashboardStats {
  /** Today's figures, composed client-side from the occupancy, reservation and revenue endpoints. */
  totalRooms: number;
  occupiedRooms: number;
  availableRooms: number;
  occupancyPercent: number;
  todayCheckIns: number;
  todayCheckOuts: number;
  todayBookings: number;
  todayRevenue: number;
  currency: string;
}

export interface RevenueReport {
  period: string;
  currency?: string;
  /** Room revenue net of discounts, excluding tax (as the backend defines it). */
  totalRevenue: number;
  adr: number;
  revPar: number;
  bySource: {
    source: ReservationSource;
    revenue: number;
    bookings: number;
    roomNights?: number;
    percentage: number;
  }[];
}

export interface OccupancyReport {
  date: string;
  totalRooms: number;
  soldRooms: number;
  blockedRooms: number;
  availableRooms: number;
  occupancyPercent: number;
}

// ---------------------------------------------------------------- Public Booking Engine
export interface PublicPropertyData {
  _id?: string;
  name: string;
  slug: string;
  description: string;
  address: string;
  city: string;
  state: string;
  country: string;
  phone?: string;
  email?: string;
  currency: string;
  timezone: string;
  checkInTime: string;
  checkOutTime: string;
  amenities: string[];
  images: PropertyImage[];
  roomTypes: PublicRoomType[];
  taxPercent?: number;
}

/** One result of GET /public/properties. The stay fields are present only when the search had dates. */
export interface PublicPropertySearchItem {
  slug: string;
  name: string;
  description?: string;
  city: string;
  state: string;
  country: string;
  currency: string;
  image: { url: string; caption?: string } | null;
  amenities: string[];
  /** Lowest nightly price before tax, minor units. */
  startingFromPrice: number;
  maxOccupancy: number;
  nights?: number;
  availableFromNightly?: number;
  availableFromTotal?: number;
  availableRoomTypes?: number;
}

export interface PublicPropertySearchResult {
  items: PublicPropertySearchItem[];
  page: number;
  limit: number;
  total: number;
}

export interface PublicPropertySearchParams {
  q?: string;
  checkIn?: string;
  checkOut?: string;
  adults?: number;
  /** Minor units (paise). */
  minPrice?: number;
  maxPrice?: number;
  amenities?: string[];
  sort?: 'recommended' | 'price_asc' | 'price_desc';
  page?: number;
}

export interface PublicRoomType {
  _id: string;
  name: string;
  description?: string;
  maxOccupancy: number;
  currency: string;
  amenities: string[];
  images: PropertyImage[];
  startingFromPrice: number;
}

export interface PublicAvailabilityItem {
  roomTypeId: string;
  roomTypeName: string;
  description: string;
  maxOccupancy: number;
  amenities: string[];
  images: PropertyImage[];
  availableRooms: number;
  /** false when restrictions (stop-sell, min stay, occupancy...) block this room type; see reasons. */
  bookable: boolean;
  reasons: string[];
  ratePlans: {
    ratePlanId: string;
    name: string;
    mealPlan: MealPlan;
    totalPrice: number;
    subtotal: number;
    nightlyPrice: number;
    discountAmount: number;
    taxAmount: number;
    cancellationDescription: string;
  }[];
}

export interface PublicBookingInput {
  propertySlug: string;
  roomTypeId: string;
  ratePlanId: string;
  quantity: number;
  checkIn: string;
  checkOut: string;
  adults: number;
  children?: number;
  guest: {
    firstName: string;
    lastName: string;
    email: string;
    phone: string;
    country?: string;
  };
  promoCode?: string;
  specialRequests?: string;
}

/** Razorpay Checkout parameters returned by the server for online payment (null when payment is not required). */
export interface CheckoutParams {
  provider: string;
  keyId: string;
  orderId: string;
  amount: number;
  currency: string;
  reservationCode: string;
  prefill: Record<string, string>;
}

/** What a guest may see about their booking (POST /public/reservations and GET /public/reservations/:code). */
export interface PublicReservationView {
  reservationCode: string;
  status: ReservationStatus;
  propertyName: string;
  checkIn: string;
  checkOut: string;
  nights: number;
  adults: number;
  children: number;
  rooms: { roomTypeName: string; ratePlan?: string; mealPlan?: string; cancellationDescription?: string; total: number }[];
  subtotal: number;
  tax: number;
  discount: number;
  total: number;
  currency: string;
  paymentStatus: ReservationPaymentStatus;
  /** ISO time until which a PENDING booking holds its rooms; absent once confirmed. */
  holdExpiresAt?: string;
}

export interface PublicBookingResult {
  reservation: PublicReservationView;
  /** Razorpay Checkout parameters; null when the server does not require online payment. */
  payment: CheckoutParams | null;
  /** false when the request was an idempotent replay of an earlier one. */
  created: boolean;
}
