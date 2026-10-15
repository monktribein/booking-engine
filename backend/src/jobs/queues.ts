import { SyncJobType } from '../database/enums';

export const QUEUES = {
  WEBHOOK: 'webhook-processing',
  INVENTORY_SYNC: 'inventory-sync',
  RATE_SYNC: 'rate-sync',
  RESERVATION_SYNC: 'reservation-sync',
  NOTIFICATION: 'notification',
  PAYMENT: 'payment',
  CLIENT_WEBHOOK: 'client-webhook',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];
export const ALL_QUEUES: QueueName[] = Object.values(QUEUES);

/** Job payloads. Jobs carry ids only: workers always re-read current state from MongoDB. */
export interface JobPayloads {
  'webhook-processing': { webhookEventId: string };
  'inventory-sync': { syncJobId: string };
  'rate-sync': { syncJobId: string };
  'reservation-sync':
    | { kind: 'SYNC_JOB'; syncJobId: string }
    | { kind: 'ACKNOWLEDGE'; propertyId: string; channel: string; externalReservationId: string }
    | { kind: 'PULL'; connectionId: string };
  notification: { notificationId: string };
  payment: { kind: 'WEBHOOK'; webhookEventId: string } | { kind: 'REFUND'; refundId: string };
  'client-webhook': { deliveryId: string };
}

/** Per-queue retry policy: exponential backoff, failures kept 14 days for inspection. */
export const QUEUE_OPTIONS: Record<QueueName, { attempts: number; backoffMs: number; concurrency: number }> = {
  'webhook-processing': { attempts: 10, backoffMs: 5_000, concurrency: 5 },
  'inventory-sync': { attempts: 8, backoffMs: 15_000, concurrency: 10 },
  'rate-sync': { attempts: 8, backoffMs: 15_000, concurrency: 5 },
  'reservation-sync': { attempts: 8, backoffMs: 30_000, concurrency: 5 },
  notification: { attempts: 5, backoffMs: 30_000, concurrency: 10 },
  payment: { attempts: 6, backoffMs: 20_000, concurrency: 5 },
  'client-webhook': { attempts: 8, backoffMs: 30_000, concurrency: 10 },
};

export function queueForSyncType(type: SyncJobType): QueueName {
  switch (type) {
    case SyncJobType.INVENTORY:
    case SyncJobType.RESTRICTIONS:
      return QUEUES.INVENTORY_SYNC;
    case SyncJobType.RATES:
      return QUEUES.RATE_SYNC;
    default:
      return QUEUES.RESERVATION_SYNC;
  }
}
