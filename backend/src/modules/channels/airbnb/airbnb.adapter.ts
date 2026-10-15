import { Injectable } from '@nestjs/common';
import { ChannelCode } from '../../../database/enums';
import { PartnerChannelAdapter } from '../interfaces/partner-channel.adapter';

/**
 * Airbnb. Airbnb's API is available only to approved software connectivity
 * partners. Listing, availability, pricing and reservation endpoints, the
 * OAuth consent flow and webhook signing are documented privately to them.
 *
 * Integration notes for implementers (keep all of this inside this folder):
 *  - One Airbnb listing = one sellable unit → map with externalRoomId = null.
 *  - Connect through Airbnb's documented OAuth consent. Store only the tokens
 *    returned (ChannelsService encrypts them). Never ask hosts for passwords or keys.
 *  - Push absolute availability/prices per date (the sync engine already
 *    sends absolute values, so retries are safe).
 */
@Injectable()
export class AirbnbAdapter extends PartnerChannelAdapter {
  readonly channel = ChannelCode.AIRBNB;
  readonly displayName = 'Airbnb';
  protected readonly partnerProgramme = 'Airbnb Software Connectivity Partner program';
}
