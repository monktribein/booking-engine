import {
  ChannelCode,
  ChannelConnectionStatus,
  PaymentStatus,
  ReservationSource,
  ReservationStatus,
  RoomStatus,
} from '@/types/enums';

export function getStatusBadgeVariant(status: ReservationStatus): {
  bg: string;
  text: string;
  border: string;
  label: string;
} {
  switch (status) {
    case ReservationStatus.CONFIRMED:
      return { bg: 'bg-emerald-500/10', text: 'text-emerald-700 dark:text-emerald-400', border: 'border-emerald-500/20', label: 'Confirmed' };
    case ReservationStatus.CHECKED_IN:
      return { bg: 'bg-blue-500/10', text: 'text-blue-700 dark:text-blue-400', border: 'border-blue-500/20', label: 'Checked In' };
    case ReservationStatus.CHECKED_OUT:
      return { bg: 'bg-slate-500/10', text: 'text-slate-700 dark:text-slate-400', border: 'border-slate-500/20', label: 'Checked Out' };
    case ReservationStatus.PENDING:
      return { bg: 'bg-amber-500/10', text: 'text-amber-700 dark:text-amber-400', border: 'border-amber-500/20', label: 'Pending' };
    case ReservationStatus.CANCELLED:
      return { bg: 'bg-rose-500/10', text: 'text-rose-700 dark:text-rose-400', border: 'border-rose-500/20', label: 'Cancelled' };
    case ReservationStatus.NO_SHOW:
      return { bg: 'bg-purple-500/10', text: 'text-purple-700 dark:text-purple-400', border: 'border-purple-500/20', label: 'No Show' };
    default:
      return { bg: 'bg-slate-500/10', text: 'text-slate-700 dark:text-slate-400', border: 'border-slate-500/20', label: status };
  }
}

export function getRoomStatusBadge(status: RoomStatus): {
  bg: string;
  text: string;
  dot: string;
  label: string;
} {
  switch (status) {
    case RoomStatus.AVAILABLE:
      return { bg: 'bg-emerald-50 dark:bg-emerald-950/30', text: 'text-emerald-700 dark:text-emerald-400', dot: 'bg-emerald-500', label: 'Available' };
    case RoomStatus.OCCUPIED:
      return { bg: 'bg-blue-50 dark:bg-blue-950/30', text: 'text-blue-700 dark:text-blue-400', dot: 'bg-blue-500', label: 'Occupied' };
    case RoomStatus.CLEANING:
      return { bg: 'bg-amber-50 dark:bg-amber-950/30', text: 'text-amber-700 dark:text-amber-400', dot: 'bg-amber-500', label: 'Cleaning' };
    case RoomStatus.MAINTENANCE:
      return { bg: 'bg-rose-50 dark:bg-rose-950/30', text: 'text-rose-700 dark:text-rose-400', dot: 'bg-rose-500', label: 'Maintenance' };
    case RoomStatus.BLOCKED:
      return { bg: 'bg-slate-100 dark:bg-slate-800', text: 'text-slate-700 dark:text-slate-300', dot: 'bg-slate-500', label: 'Blocked' };
    default:
      return { bg: 'bg-slate-100', text: 'text-slate-700', dot: 'bg-slate-400', label: status };
  }
}

export function getChannelBadge(channel: ReservationSource | ChannelCode | string): {
  bg: string;
  text: string;
  label: string;
  iconColor: string;
} {
  switch (channel) {
    case ReservationSource.AIRBNB:
    case ChannelCode.AIRBNB:
      return { bg: 'bg-rose-50 dark:bg-rose-950/30', text: 'text-rose-700 dark:text-rose-400', label: 'Airbnb', iconColor: '#FF5A5F' };
    case ReservationSource.BOOKING_COM:
    case ChannelCode.BOOKING_COM:
      return { bg: 'bg-sky-50 dark:bg-sky-950/30', text: 'text-sky-700 dark:text-sky-400', label: 'Booking.com', iconColor: '#003580' };
    case ReservationSource.AGODA:
    case ChannelCode.AGODA:
      return { bg: 'bg-purple-50 dark:bg-purple-950/30', text: 'text-purple-700 dark:text-purple-400', label: 'Agoda', iconColor: '#5392F9' };
    case ReservationSource.DIRECT:
    case ChannelCode.DIRECT:
      return { bg: 'bg-emerald-50 dark:bg-emerald-950/30', text: 'text-emerald-700 dark:text-emerald-400', label: 'Direct', iconColor: '#10B981' };
    case ReservationSource.TIRVONA:
    case ChannelCode.TIRVONA:
      return { bg: 'bg-indigo-50 dark:bg-indigo-950/30', text: 'text-indigo-700 dark:text-indigo-400', label: 'Tirvona', iconColor: '#6366F1' };
    case ReservationSource.WALK_IN:
      return { bg: 'bg-amber-50 dark:bg-amber-950/30', text: 'text-amber-700 dark:text-amber-400', label: 'Walk-in', iconColor: '#F59E0B' };
    default:
      return { bg: 'bg-slate-100 dark:bg-slate-800', text: 'text-slate-700 dark:text-slate-300', label: String(channel), iconColor: '#64748B' };
  }
}

export function getChannelConnectionBadge(status: ChannelConnectionStatus): {
  bg: string;
  text: string;
  dot: string;
  label: string;
} {
  switch (status) {
    case ChannelConnectionStatus.CONNECTED:
      return { bg: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/30 dark:text-emerald-400 dark:border-emerald-800', text: 'text-emerald-700', dot: 'bg-emerald-500', label: 'Connected' };
    case ChannelConnectionStatus.CONNECTING:
      return { bg: 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/30 dark:text-blue-400 dark:border-blue-800', text: 'text-blue-700', dot: 'bg-blue-500', label: 'Connecting' };
    case ChannelConnectionStatus.ERROR:
      return { bg: 'bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-950/30 dark:text-rose-400 dark:border-rose-800', text: 'text-rose-700', dot: 'bg-rose-500', label: 'Error' };
    case ChannelConnectionStatus.EXPIRED:
      return { bg: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/30 dark:text-amber-400 dark:border-amber-800', text: 'text-amber-700', dot: 'bg-amber-500', label: 'Expired' };
    case ChannelConnectionStatus.DISCONNECTED:
    default:
      return { bg: 'bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700', text: 'text-slate-600', dot: 'bg-slate-400', label: 'Not Connected' };
  }
}

export function getPaymentStatusBadge(status: PaymentStatus): {
  bg: string;
  text: string;
  label: string;
} {
  switch (status) {
    case PaymentStatus.PAID:
      return { bg: 'bg-emerald-50 text-emerald-700 border-emerald-200', text: 'text-emerald-700', label: 'Paid' };
    case PaymentStatus.PENDING:
      return { bg: 'bg-amber-50 text-amber-700 border-amber-200', text: 'text-amber-700', label: 'Pending' };
    case PaymentStatus.FAILED:
      return { bg: 'bg-rose-50 text-rose-700 border-rose-200', text: 'text-rose-700', label: 'Failed' };
    case PaymentStatus.REFUNDED:
      return { bg: 'bg-purple-50 text-purple-700 border-purple-200', text: 'text-purple-700', label: 'Refunded' };
    case PaymentStatus.PARTIALLY_REFUNDED:
      return { bg: 'bg-indigo-50 text-indigo-700 border-indigo-200', text: 'text-indigo-700', label: 'Partially Refunded' };
    default:
      return { bg: 'bg-slate-100 text-slate-700 border-slate-200', text: 'text-slate-700', label: status };
  }
}
