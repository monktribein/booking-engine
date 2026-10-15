import type { Connection, Model, Schema } from 'mongoose';
import { MODEL } from './constants';
import {
  Organization,
  OrganizationSchema,
  PropertyUser,
  PropertyUserSchema,
  User,
  UserSchema,
} from './schemas/identity.schema';
import {
  Property,
  PropertySchema,
  RatePlan,
  RatePlanSchema,
  Room,
  RoomSchema,
  RoomType,
  RoomTypeSchema,
} from './schemas/property.schema';
import {
  Inventory,
  InventoryBlock,
  InventoryBlockSchema,
  InventorySchema,
  Restriction,
  RestrictionSchema,
} from './schemas/inventory.schema';
import { Guest, GuestSchema } from './schemas/guest.schema';
import { Reservation, ReservationSchema } from './schemas/reservation.schema';
import { Payment, PaymentSchema, Refund, RefundSchema } from './schemas/payment.schema';
import {
  Channel,
  ChannelConnection,
  ChannelConnectionSchema,
  ChannelListing,
  ChannelListingSchema,
  ChannelRateMapping,
  ChannelRateMappingSchema,
  ChannelRoomMapping,
  ChannelRoomMappingSchema,
  ChannelSchema,
} from './schemas/channel.schema';
import {
  AuditLog,
  AuditLogSchema,
  Notification,
  NotificationSchema,
  SyncJob,
  SyncJobSchema,
  SyncLog,
  SyncLogSchema,
  WebhookEvent,
  WebhookEventSchema,
} from './schemas/ops.schema';
import { AuthSession, AuthSessionSchema, PasswordResetToken, PasswordResetTokenSchema } from './schemas/auth.schema';
import { Promotion, PromotionSchema } from './schemas/promotion.schema';
import { ApiKey, ApiKeySchema, WebhookDelivery, WebhookDeliverySchema, WebhookEndpoint, WebhookEndpointSchema } from './schemas/api.schema';

/** Pass straight to MongooseModule.forFeature(MODEL_DEFINITIONS). */
export const MODEL_DEFINITIONS: { name: string; schema: Schema<any> }[] = [
  { name: MODEL.Organization, schema: OrganizationSchema },
  { name: MODEL.User, schema: UserSchema },
  { name: MODEL.PropertyUser, schema: PropertyUserSchema },
  { name: MODEL.Property, schema: PropertySchema },
  { name: MODEL.RoomType, schema: RoomTypeSchema },
  { name: MODEL.Room, schema: RoomSchema },
  { name: MODEL.RatePlan, schema: RatePlanSchema },
  { name: MODEL.Inventory, schema: InventorySchema },
  { name: MODEL.InventoryBlock, schema: InventoryBlockSchema },
  { name: MODEL.Restriction, schema: RestrictionSchema },
  { name: MODEL.Guest, schema: GuestSchema },
  { name: MODEL.Reservation, schema: ReservationSchema },
  { name: MODEL.Payment, schema: PaymentSchema },
  { name: MODEL.Refund, schema: RefundSchema },
  { name: MODEL.Channel, schema: ChannelSchema },
  { name: MODEL.ChannelConnection, schema: ChannelConnectionSchema },
  { name: MODEL.ChannelListing, schema: ChannelListingSchema },
  { name: MODEL.ChannelRoomMapping, schema: ChannelRoomMappingSchema },
  { name: MODEL.ChannelRateMapping, schema: ChannelRateMappingSchema },
  { name: MODEL.WebhookEvent, schema: WebhookEventSchema },
  { name: MODEL.SyncJob, schema: SyncJobSchema },
  { name: MODEL.SyncLog, schema: SyncLogSchema },
  { name: MODEL.Notification, schema: NotificationSchema },
  { name: MODEL.AuditLog, schema: AuditLogSchema },
  { name: MODEL.AuthSession, schema: AuthSessionSchema },
  { name: MODEL.PasswordResetToken, schema: PasswordResetTokenSchema },
  { name: MODEL.Promotion, schema: PromotionSchema },
  { name: MODEL.ApiKey, schema: ApiKeySchema },
  { name: MODEL.WebhookEndpoint, schema: WebhookEndpointSchema },
  { name: MODEL.WebhookDelivery, schema: WebhookDeliverySchema },
];

/** For scripts and tests that run outside Nest. */
export function registerModels(connection: Connection): void {
  for (const { name, schema } of MODEL_DEFINITIONS) {
    if (!connection.models[name]) connection.model(name, schema);
  }
}

export function getModels(connection: Connection) {
  const m = <T>(name: string) => connection.model(name) as Model<T>;
  return {
    Organization: m<Organization>(MODEL.Organization),
    User: m<User>(MODEL.User),
    PropertyUser: m<PropertyUser>(MODEL.PropertyUser),
    Property: m<Property>(MODEL.Property),
    RoomType: m<RoomType>(MODEL.RoomType),
    Room: m<Room>(MODEL.Room),
    RatePlan: m<RatePlan>(MODEL.RatePlan),
    Inventory: m<Inventory>(MODEL.Inventory),
    InventoryBlock: m<InventoryBlock>(MODEL.InventoryBlock),
    Restriction: m<Restriction>(MODEL.Restriction),
    Guest: m<Guest>(MODEL.Guest),
    Reservation: m<Reservation>(MODEL.Reservation),
    Payment: m<Payment>(MODEL.Payment),
    Refund: m<Refund>(MODEL.Refund),
    Channel: m<Channel>(MODEL.Channel),
    ChannelConnection: m<ChannelConnection>(MODEL.ChannelConnection),
    ChannelListing: m<ChannelListing>(MODEL.ChannelListing),
    ChannelRoomMapping: m<ChannelRoomMapping>(MODEL.ChannelRoomMapping),
    ChannelRateMapping: m<ChannelRateMapping>(MODEL.ChannelRateMapping),
    WebhookEvent: m<WebhookEvent>(MODEL.WebhookEvent),
    SyncJob: m<SyncJob>(MODEL.SyncJob),
    SyncLog: m<SyncLog>(MODEL.SyncLog),
    Notification: m<Notification>(MODEL.Notification),
    AuditLog: m<AuditLog>(MODEL.AuditLog),
    AuthSession: m<AuthSession>(MODEL.AuthSession),
    PasswordResetToken: m<PasswordResetToken>(MODEL.PasswordResetToken),
    Promotion: m<Promotion>(MODEL.Promotion),
    ApiKey: m<ApiKey>(MODEL.ApiKey),
    WebhookEndpoint: m<WebhookEndpoint>(MODEL.WebhookEndpoint),
    WebhookDelivery: m<WebhookDelivery>(MODEL.WebhookDelivery),
  };
}

export type Models = ReturnType<typeof getModels>;
