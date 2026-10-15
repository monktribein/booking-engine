import { Injectable } from '@nestjs/common';
import { ChannelCode } from '../../../database/enums';
import { PartnerChannelAdapter } from '../interfaces/partner-channel.adapter';

/**
 * Booking.com. Its connectivity APIs (availability/rates/restrictions,
 * reservations, content) are available to approved Connectivity Partners and
 * documented on the partner portal.
 *
 * Integration notes for implementers (keep all of this inside this folder):
 *  - One Booking.com hotel (listing) contains several rooms and rate plans →
 *    map each externalRoomId to a Tirvona room type and each external rate
 *    plan through channel_rate_mappings.
 *  - Properties connect by selecting Tirvona as their connectivity provider
 *    in the Booking.com extranet, not by sharing credentials. connect() should
 *    return the documented activation flow.
 *  - Reservations must be acknowledged after import (acknowledgeReservation).
 */
@Injectable()
export class BookingComAdapter extends PartnerChannelAdapter {
  readonly channel = ChannelCode.BOOKING_COM;
  readonly displayName = 'Booking.com';
  protected readonly partnerProgramme = 'Booking.com Connectivity Partner Programme';
}
