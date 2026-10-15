import type { ChannelCode } from '../../../database/enums';
import { ChannelError } from '../../../database/errors';
import type { NormalizedReservationEvent } from '../../../database/services/webhook.service';
import type {
  AvailabilityUpdate,
  ChannelAdapter,
  ChannelCredentials,
  CompleteConnectContext,
  ConnectContext,
  ConnectResult,
  ExternalListing,
  ExternalRatePlan,
  ExternalRoomType,
  InboundWebhookRequest,
  ParsedWebhook,
  PushResult,
  RateUpdate,
  RestrictionUpdate,
} from './channel-adapter.interface';

/**
 * Base for OTAs whose connectivity APIs are only available to approved
 * connectivity partners under NDA-bound documentation.
 *
 * Tirvona does not implement undocumented or reverse-engineered OTA APIs.
 * Until partner access is granted and the adapter is written against the
 * official documentation, every operation fails with the non-retryable
 * CHANNEL_INTEGRATION_NOT_AVAILABLE. The rest of the platform (mappings,
 * sync jobs, webhooks) is ready: an implementation only has to fill in
 * these methods.
 *
 * Webhooks addressed to such a channel are stored for audit but never
 * processed: verifyWebhook() returns false until a real verifier exists.
 */
export abstract class PartnerChannelAdapter implements ChannelAdapter {
  abstract readonly channel: ChannelCode;
  abstract readonly displayName: string;
  /** Where the official partner programme lives, for operators reading the error. */
  protected abstract readonly partnerProgramme: string;

  isAvailable(): boolean {
    return false;
  }

  protected unavailable(operation: string): never {
    throw new ChannelError(
      'CHANNEL_INTEGRATION_NOT_AVAILABLE',
      `${this.displayName} ${operation} requires approved connectivity-partner API access (${this.partnerProgramme}). ` +
        `Implement it in src/modules/channels/ against the official partner documentation.`,
      false,
    );
  }

  async connect(_ctx: ConnectContext): Promise<ConnectResult> {
    return this.unavailable('connection');
  }
  async completeConnect(_ctx: CompleteConnectContext): Promise<ChannelCredentials> {
    return this.unavailable('authorization');
  }
  async disconnect(_creds: ChannelCredentials): Promise<void> {
    // Nothing to revoke remotely without partner access; local credentials are wiped by ChannelsService.
  }
  async getListings(_creds: ChannelCredentials): Promise<ExternalListing[]> {
    return this.unavailable('listing import');
  }
  async getRoomTypes(_creds: ChannelCredentials, _listingId: string): Promise<ExternalRoomType[]> {
    return this.unavailable('room import');
  }
  async getRates(_creds: ChannelCredentials, _listingId: string): Promise<ExternalRatePlan[]> {
    return this.unavailable('rate plan import');
  }
  async getReservations(_creds: ChannelCredentials, _q: { since: Date }): Promise<NormalizedReservationEvent[]> {
    return this.unavailable('reservation retrieval');
  }
  async getReservation(_creds: ChannelCredentials, _id: string): Promise<NormalizedReservationEvent | null> {
    return this.unavailable('reservation retrieval');
  }
  async updateAvailability(_creds: ChannelCredentials, _u: AvailabilityUpdate[]): Promise<PushResult> {
    return this.unavailable('availability push');
  }
  async updateRates(_creds: ChannelCredentials, _u: RateUpdate[]): Promise<PushResult> {
    return this.unavailable('rate push');
  }
  async updateRestrictions(_creds: ChannelCredentials, _u: RestrictionUpdate[]): Promise<PushResult> {
    return this.unavailable('restriction push');
  }
  async acknowledgeReservation(_creds: ChannelCredentials, _id: string): Promise<void> {
    return this.unavailable('reservation acknowledgement');
  }
  verifyWebhook(_req: InboundWebhookRequest): boolean {
    return false;
  }
  parseWebhook(_body: unknown): ParsedWebhook {
    return this.unavailable('webhook parsing');
  }
}
