import { Injectable } from '@nestjs/common';
import { ChannelCode } from '../../../database/enums';
import { PartnerChannelAdapter } from '../interfaces/partner-channel.adapter';

/**
 * Agoda. Its supply connectivity API is available to approved connectivity
 * partners and documented privately to them.
 *
 * Integration notes for implementers (keep all of this inside this folder):
 *  - Hotel-style listing with several rooms → one mapping per externalRoomId.
 *  - Activation happens by the property choosing Tirvona as its connectivity
 *    partner on Agoda's side, not by sharing credentials with Tirvona.
 */
@Injectable()
export class AgodaAdapter extends PartnerChannelAdapter {
  readonly channel = ChannelCode.AGODA;
  readonly displayName = 'Agoda';
  protected readonly partnerProgramme = 'Agoda connectivity partner program';
}
