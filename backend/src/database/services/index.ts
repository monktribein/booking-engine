import type { Db } from '../kysely';
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
export function createServices(db: Db) {
  const audit = new AuditService(db);
  const channels = new ChannelMappingService(db);
  const syncJobs = new SyncJobService(db, channels);
  const clientEvents = new ClientEventService(db);
  const inventory = new InventoryService(db, syncJobs, audit, clientEvents);
  const reservations = new ReservationService(db, inventory, syncJobs, audit, clientEvents);
  return {
    audit,
    clientEvents,
    channels,
    syncJobs,
    inventory,
    reservations,
    availability: new AvailabilityService(db),
    calendar: new CalendarService(db),
    webhooks: new WebhookService(db, channels, reservations),
  };
}

export type Services = ReturnType<typeof createServices>;
