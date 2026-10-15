import { Injectable } from '@nestjs/common';
import { ChannelCode, INTERNAL_CHANNELS } from '../../database/enums';
import { DomainError } from '../../database/errors';
import { AgodaAdapter } from './agoda/agoda.adapter';
import { AirbnbAdapter } from './airbnb/airbnb.adapter';
import { BookingComAdapter } from './booking-com/booking-com.adapter';
import type { ChannelAdapter } from './interfaces/channel-adapter.interface';
import { MockChannelAdapter } from './mock/mock-channel.adapter';

/**
 * The only place that knows which adapter serves which channel. Adding an OTA
 * means writing an adapter and registering it here. Nothing else changes.
 */
@Injectable()
export class ChannelAdapterRegistry {
  private readonly adapters: Map<ChannelCode, ChannelAdapter>;

  constructor(airbnb: AirbnbAdapter, bookingCom: BookingComAdapter, agoda: AgodaAdapter, mock: MockChannelAdapter) {
    this.adapters = new Map<ChannelCode, ChannelAdapter>([
      [ChannelCode.AIRBNB, airbnb],
      [ChannelCode.BOOKING_COM, bookingCom],
      [ChannelCode.AGODA, agoda],
      ...(mock.isAvailable() ? ([[ChannelCode.MOCK, mock]] as const) : []),
    ]);
  }

  get(channel: string): ChannelAdapter {
    const adapter = this.adapters.get(channel as ChannelCode);
    if (!adapter) {
      const internal = INTERNAL_CHANNELS.has(channel as ChannelCode);
      throw new DomainError(
        'CHANNEL_NOT_SUPPORTED',
        internal ? `${channel} reads Tirvona inventory directly and needs no connection` : `Unknown channel ${channel}`,
      );
    }
    return adapter;
  }

  list(): ChannelAdapter[] {
    return [...this.adapters.values()];
  }
}
