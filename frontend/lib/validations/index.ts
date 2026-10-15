import { z } from 'zod';

// Auth Schemas
export const loginSchema = z.object({
  email: z.string().email('Please enter a valid email address'),
  password: z.string().min(6, 'Password must be at least 6 characters'),
});
export type LoginFormData = z.infer<typeof loginSchema>;

export const registerSchema = z.object({
  organizationName: z.string().min(2, 'Organization name must be at least 2 characters'),
  name: z.string().min(2, 'Name must be at least 2 characters'),
  email: z.string().email('Please enter a valid email address'),
  phone: z.string().optional(),
  password: z.string().min(8, 'Password must be at least 8 characters'),
});
export type RegisterFormData = z.infer<typeof registerSchema>;

export const forgotPasswordSchema = z.object({
  email: z.string().email('Please enter a valid email address'),
});
export type ForgotPasswordFormData = z.infer<typeof forgotPasswordSchema>;

// Property Schema
export const propertySchema = z.object({
  name: z.string().min(2, 'Property name is required'),
  description: z.string().min(10, 'Description should be at least 10 characters'),
  address: z.string().min(5, 'Address is required'),
  city: z.string().min(2, 'City is required'),
  state: z.string().min(2, 'State is required'),
  country: z.string().length(2, 'Country code must be 2 letters (e.g. IN)'),
  phone: z.string().optional(),
  email: z.string().email().optional(),
  checkInTime: z.string().regex(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/, 'Must be in HH:MM format'),
  checkOutTime: z.string().regex(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/, 'Must be in HH:MM format'),
  taxPercent: z.number().min(0).max(100),
  amenities: z.array(z.string()).default([]),
});
export type PropertyFormData = z.infer<typeof propertySchema>;

// Room Type Schema
export const roomTypeSchema = z.object({
  name: z.string().min(2, 'Room type name is required'),
  slug: z.string().min(2, 'Slug is required'),
  description: z.string().optional(),
  maxOccupancy: z.number().int().min(1, 'At least 1 guest capacity required'),
  basePriceMajor: z.number().positive('Base price must be greater than 0'),
  totalRooms: z.number().int().min(1, 'Must have at least 1 room'),
  amenities: z.array(z.string()).default([]),
});
export type RoomTypeFormData = z.infer<typeof roomTypeSchema>;

// Physical Room Schema
export const physicalRoomSchema = z.object({
  roomNumber: z.string().min(1, 'Room number is required'),
  floor: z.string().optional(),
});
export type PhysicalRoomFormData = z.infer<typeof physicalRoomSchema>;

// Room Status Change Schema
export const roomStatusChangeSchema = z.object({
  status: z.enum(['AVAILABLE', 'OCCUPIED', 'CLEANING', 'MAINTENANCE', 'BLOCKED']),
  blockInventory: z.boolean().default(false),
  notes: z.string().optional(),
});
export type RoomStatusChangeFormData = z.infer<typeof roomStatusChangeSchema>;

// Reservation Schema
export const reservationSchema = z.object({
  guestFirstName: z.string().min(2, 'First name is required'),
  guestLastName: z.string().min(1, 'Last name is required'),
  guestEmail: z.string().email('Valid email required').optional().or(z.literal('')),
  guestPhone: z.string().min(8, 'Phone number required'),
  roomTypeId: z.string().min(1, 'Room type is required'),
  ratePlanId: z.string().min(1, 'Rate plan is required'),
  checkIn: z.string().min(10, 'Check-in date required'),
  checkOut: z.string().min(10, 'Check-out date required'),
  adults: z.number().int().min(1, 'At least 1 adult required'),
  children: z.number().int().min(0).default(0),
  source: z.string().default('DIRECT'),
  specialRequests: z.string().optional(),
});
export type ReservationFormData = z.infer<typeof reservationSchema>;

// Channel Mapping Schema
export const channelMappingSchema = z.object({
  channelListingId: z.string().min(1, 'Listing ID is required'),
  externalRoomId: z.string().optional(),
  roomTypeId: z.string().min(1, 'Room type must be selected'),
  markupType: z.enum(['PERCENTAGE', 'FIXED', 'NONE']).default('PERCENTAGE'),
  markupValue: z.number().min(0).default(10),
});
export type ChannelMappingFormData = z.infer<typeof channelMappingSchema>;

// Rate Plan Schema
export const ratePlanSchema = z.object({
  roomTypeId: z.string().min(1, 'Room type is required'),
  code: z.string().min(2, 'Rate code is required'),
  name: z.string().min(2, 'Rate plan name is required'),
  type: z.enum(['STANDARD', 'NON_REFUNDABLE', 'BREAKFAST', 'CUSTOM']),
  basePriceMajor: z.number().positive('Price must be greater than 0'),
  mealPlan: z.enum(['ROOM_ONLY', 'BREAKFAST', 'HALF_BOARD', 'FULL_BOARD', 'ALL_INCLUSIVE']),
  cancellationRefundable: z.boolean().default(true),
  freeCancellationHours: z.number().min(0).default(48),
});
export type RatePlanFormData = z.infer<typeof ratePlanSchema>;

// Public Booking Guest Schema
export const publicGuestSchema = z.object({
  firstName: z.string().min(2, 'First name is required'),
  lastName: z.string().min(1, 'Last name is required'),
  email: z.string().email('Please enter a valid email address'),
  phone: z.string().min(8, 'Please enter a valid phone number'),
  specialRequests: z.string().optional(),
});
export type PublicGuestFormData = z.infer<typeof publicGuestSchema>;
