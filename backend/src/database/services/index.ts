import type { Connection } from 'mongoose';
import { registerModels } from '../models';
import { AuditService } from './audit.service';
import { AvailabilityService, CalendarService } from './availability.service';
import { ChannelMappingService } from './channel-mapping.service';
import { ClientEventService } from './client-event.service';
import { InventoryService } from './inventory.service';
import { ReservationService } from './reservation.service';
import { SyncJobService } from './sync-job.service';
import { WebhookService } from './webhook.service';

export {
  AuditService,
  AvailabilityService,
  CalendarService,
  ChannelMappingService,
  ClientEventService,
  InventoryService,
  ReservationService,
  SyncJobService,
  WebhookService,
};

export const DATABASE_SERVICES = [
  AuditService,
  AvailabilityService,
  CalendarService,
  ChannelMappingService,
  ClientEventService,
  InventoryService,
  ReservationService,
  SyncJobService,
  WebhookService,
];

/** Manual wiring for scripts, workers and tests that run outside Nest's DI container. */
export function createServices(connection: Connection) {
  registerModels(connection);
  const audit = new AuditService(connection);
  const channels = new ChannelMappingService(connection);
  const syncJobs = new SyncJobService(connection, channels);
  const inventory = new InventoryService(connection, syncJobs, audit);
  const clientEvents = new ClientEventService(connection);
  const reservations = new ReservationService(connection, inventory, syncJobs, audit, clientEvents);
  return {
    audit,
    clientEvents,
    channels,
    syncJobs,
    inventory,
    reservations,
    availability: new AvailabilityService(connection),
    calendar: new CalendarService(connection),
    webhooks: new WebhookService(connection, channels, reservations),
  };
}

export type Services = ReturnType<typeof createServices>;
