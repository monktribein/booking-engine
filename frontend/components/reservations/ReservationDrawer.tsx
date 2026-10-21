'use client';

import React, { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Drawer } from '../ui/drawer';
import { Button } from '../ui/button';
import { Reservation, ReservationStatus } from '@/types';
import { PaymentVisibilityPanel } from '@/components/payments/PaymentVisibilityPanel';
import { formatCurrency } from '@/lib/utils/currency';
import { formatDate, calculateNights } from '@/lib/utils/dates';
import { getChannelBadge, getStatusBadgeVariant } from '@/lib/utils/formatters';
import { reservationsApi } from '@/lib/api/reservations';
import { roomsApi } from '@/lib/api/rooms';
import { errorMessage } from '@/lib/utils/errors';
import { Alert } from '../ui/alert';
import { Calendar, CheckCircle2, Clock, Phone, Mail, User, AlertCircle, XCircle } from 'lucide-react';

export function ReservationDrawer({
  reservation,
  isOpen,
  onClose,
  onUpdate,
}: {
  reservation: Reservation | null;
  isOpen: boolean;
  onClose: () => void;
  onUpdate?: () => void;
}) {
  const queryClient = useQueryClient();
  const [isProcessing, setIsProcessing] = useState(false);
  const [selectedRoomId, setSelectedRoomId] = useState<string>('');
  const [actionError, setActionError] = useState<string | null>(null);
  const [cancelReason, setCancelReason] = useState('');
  const [cancelling, setCancelling] = useState(false);

  const roomTypeId = reservation?.rooms[0]?.roomTypeId;
  const roomsQuery = useQuery({
    queryKey: ['rooms', 'by-type', roomTypeId],
    queryFn: () => roomsApi.listByRoomType(roomTypeId as string),
    enabled: isOpen && !!roomTypeId,
  });

  if (!reservation) return null;

  const statusBadge = getStatusBadgeVariant(reservation.status);
  const channelBadge = getChannelBadge(reservation.source);
  const nights = calculateNights(reservation.checkIn, reservation.checkOut);

  // Physical rooms of this room type, loaded from the backend for assignment
  const primaryRoomLine = reservation.rooms[0];
  const candidateRooms = roomsQuery.data ?? [];

  const refreshAfterChange = async () => {
    await queryClient.invalidateQueries({ queryKey: ['reservations'] });
    await queryClient.invalidateQueries({ queryKey: ['calendar'] });
    onUpdate?.();
  };

  const handleAction = async (action: 'checkin' | 'checkout' | 'cancel' | 'noshow') => {
    if (isProcessing) return; // ignore double clicks
    setIsProcessing(true);
    setActionError(null);
    try {
      if (action === 'checkin') await reservationsApi.checkIn(reservation._id);
      if (action === 'checkout') await reservationsApi.checkOut(reservation._id);
      if (action === 'cancel') await reservationsApi.cancel(reservation._id, cancelReason.trim());
      if (action === 'noshow') await reservationsApi.noShow(reservation._id);
      await refreshAfterChange();
      setCancelling(false);
      setCancelReason('');
      onClose();
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setIsProcessing(false);
    }
  };

  const handleAssignRoom = async () => {
    if (!selectedRoomId || !primaryRoomLine || isProcessing) return;
    setIsProcessing(true);
    setActionError(null);
    try {
      await reservationsApi.assignRoom(reservation._id, primaryRoomLine._id, selectedRoomId);
      await refreshAfterChange();
      onClose();
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <Drawer
      isOpen={isOpen}
      onClose={onClose}
      title={`Reservation ${reservation.code}`}
      description={`Channel: ${channelBadge.label} • Booked on ${formatDate(reservation.createdAt)}`}
      width="lg"
    >
      <div className="space-y-6">
        {/* Status bar */}
        <div className="flex items-center justify-between p-4 rounded-xl bg-slate-50 dark:bg-slate-800/50 border border-slate-200/80 dark:border-slate-700/80">
          <div className="flex items-center gap-2">
            <span className={`inline-flex items-center px-3 py-1 rounded-full text-xs font-semibold border ${statusBadge.bg} ${statusBadge.text} ${statusBadge.border}`}>
              {statusBadge.label}
            </span>
            <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium ${channelBadge.bg} ${channelBadge.text}`}>
              {channelBadge.label}
            </span>
          </div>

          <div className="text-right">
            <div className="text-xs text-slate-500">Total Charged</div>
            <div className="text-lg font-bold text-slate-900 dark:text-slate-100">
              {formatCurrency(reservation.total, reservation.currency)}
            </div>
          </div>
        </div>

        {/* Quick Lifecycle Action Buttons */}
        <div className="flex flex-wrap gap-2">
          {reservation.status === ReservationStatus.PENDING && (
            <p className="w-full text-xs text-amber-700 dark:text-amber-400">
              Awaiting payment{reservation.holdExpiresAt ? ` — rooms are held until ${formatDate(reservation.holdExpiresAt, 'd MMM, h:mm a')}` : ''}. It confirms automatically when the payment is captured.
            </p>
          )}

          {reservation.status === ReservationStatus.CONFIRMED && (
            <Button
              size="sm"
              variant="primary"
              isLoading={isProcessing}
              onClick={() => handleAction('checkin')}
            >
              <CheckCircle2 className="h-4 w-4 mr-1.5" /> Check-in Guest
            </Button>
          )}

          {reservation.status === ReservationStatus.CHECKED_IN && (
            <Button
              size="sm"
              variant="primary"
              isLoading={isProcessing}
              onClick={() => handleAction('checkout')}
            >
              <Clock className="h-4 w-4 mr-1.5" /> Check-out & Release Room
            </Button>
          )}

          {reservation.status !== ReservationStatus.CANCELLED &&
            reservation.status !== ReservationStatus.CHECKED_OUT && (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  isLoading={isProcessing}
                  onClick={() => handleAction('noshow')}
                >
                  <AlertCircle className="h-4 w-4 mr-1.5 text-amber-600" /> No Show
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  disabled={isProcessing}
                  onClick={() => setCancelling((v) => !v)}
                >
                  <XCircle className="h-4 w-4 mr-1.5" /> Cancel Booking
                </Button>
              </>
            )}
        </div>

        {cancelling && (
          <div className="rounded-xl border border-rose-200 dark:border-rose-900 p-3 space-y-2">
            <label htmlFor="cancel-reason" className="block text-xs font-semibold text-slate-700 dark:text-slate-300">
              Cancellation reason (required)
            </label>
            <input
              id="cancel-reason"
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
              maxLength={500}
              className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-1.5 text-xs"
              placeholder="e.g. Guest requested cancellation"
            />
            <Button
              size="sm"
              variant="danger"
              isLoading={isProcessing}
              disabled={isProcessing || !cancelReason.trim()}
              onClick={() => handleAction('cancel')}
            >
              Confirm cancellation
            </Button>
          </div>
        )}

        {actionError && <Alert variant="danger" title="Action failed" message={actionError} onClose={() => setActionError(null)} />}

        {/* Guest Information */}
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-4 space-y-3">
          <h4 className="text-xs font-bold uppercase tracking-wider text-slate-500 flex items-center gap-1.5">
            <User className="h-4 w-4 text-indigo-500" /> Guest Details
          </h4>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
            <div>
              <span className="text-xs text-slate-500 block">Guest Name</span>
              <span className="font-semibold text-slate-900 dark:text-slate-100">
                {reservation.guest.firstName} {reservation.guest.lastName}
              </span>
            </div>
            <div>
              <span className="text-xs text-slate-500 block">Phone</span>
              <span className="font-medium text-slate-700 dark:text-slate-300 flex items-center gap-1">
                <Phone className="h-3.5 w-3.5 text-slate-500" />
                {reservation.guest.phone || 'Not provided'}
              </span>
            </div>
            <div>
              <span className="text-xs text-slate-500 block">Email</span>
              <span className="font-medium text-slate-700 dark:text-slate-300 flex items-center gap-1">
                <Mail className="h-3.5 w-3.5 text-slate-500" />
                {reservation.guest.email || 'Not provided'}
              </span>
            </div>
            <div>
              <span className="text-xs text-slate-500 block">Country</span>
              <span className="font-medium text-slate-700 dark:text-slate-300">
                {reservation.guest.country || '-'}
              </span>
            </div>
          </div>
        </div>

        {/* Stay & Room Assignment */}
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-4 space-y-3">
          <h4 className="text-xs font-bold uppercase tracking-wider text-slate-500 flex items-center gap-1.5">
            <Calendar className="h-4 w-4 text-indigo-500" /> Stay Details & Room Assignment
          </h4>

          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
            <div>
              <span className="text-xs text-slate-500 block">Check-in</span>
              <span className="font-semibold text-slate-900 dark:text-slate-100">
                {formatDate(reservation.checkIn)}
              </span>
            </div>
            <div>
              <span className="text-xs text-slate-500 block">Check-out</span>
              <span className="font-semibold text-slate-900 dark:text-slate-100">
                {formatDate(reservation.checkOut)}
              </span>
            </div>
            <div>
              <span className="text-xs text-slate-500 block">Duration</span>
              <span className="font-semibold text-slate-900 dark:text-slate-100">
                {nights} {nights === 1 ? 'Night' : 'Nights'}
              </span>
            </div>
          </div>

          <div className="pt-3 border-t border-slate-100 dark:border-slate-800 space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="text-slate-600 dark:text-slate-400">Reserved Room Type:</span>
              <span className="font-bold text-slate-900 dark:text-slate-100">
                {primaryRoomLine?.roomTypeName || '-'}
              </span>
            </div>

            <div className="flex items-center justify-between text-sm">
              <span className="text-slate-600 dark:text-slate-400">Physical Room Assigned:</span>
              <span className="font-semibold text-indigo-600 dark:text-indigo-400">
                {primaryRoomLine?.roomNumber ? `Room ${primaryRoomLine.roomNumber}` : 'Unassigned'}
              </span>
            </div>

            {/* Room Assignment Select */}
            <div className="mt-3 pt-2 flex items-center gap-2">
              <select
                aria-label="Physical room"
                value={selectedRoomId || primaryRoomLine?.roomId || ''}
                onChange={(e) => setSelectedRoomId(e.target.value)}
                className="flex-1 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-1.5 text-xs text-slate-900 dark:text-slate-100"
              >
                <option value="">{roomsQuery.isLoading ? 'Loading rooms…' : roomsQuery.isError ? 'Rooms unavailable' : '-- Choose Physical Room --'}</option>
                {candidateRooms.map((rm) => (
                  <option key={rm._id} value={rm._id}>
                    Room {rm.roomNumber} ({rm.status})
                  </option>
                ))}
              </select>
              <Button
                size="sm"
                variant="outline"
                disabled={!selectedRoomId}
                isLoading={isProcessing}
                onClick={handleAssignRoom}
              >
                Assign
              </Button>
            </div>
          </div>
        </div>

        <PaymentVisibilityPanel reservation={reservation} />

        {/* Pricing Breakdown */}
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-4 space-y-2 text-sm">
          <h4 className="text-xs font-bold uppercase tracking-wider text-slate-500">Pricing Breakdown</h4>
          <div className="flex justify-between text-slate-600 dark:text-slate-400">
            <span>Room subtotal ({nights} nights)</span>
            <span>{formatCurrency(reservation.subtotal, reservation.currency)}</span>
          </div>
          <div className="flex justify-between text-slate-600 dark:text-slate-400">
            <span>Taxes</span>
            <span>{formatCurrency(reservation.taxAmount, reservation.currency)}</span>
          </div>
          {reservation.discountAmount > 0 && (
            <div className="flex justify-between text-emerald-700 dark:text-emerald-400">
              <span>Promotion / Discount</span>
              <span>-{formatCurrency(reservation.discountAmount, reservation.currency)}</span>
            </div>
          )}
          <div className="flex justify-between font-bold text-base pt-2 border-t border-slate-100 dark:border-slate-800 text-slate-900 dark:text-slate-100">
            <span>Total</span>
            <span>{formatCurrency(reservation.total, reservation.currency)}</span>
          </div>
        </div>

        {/* Activity Timeline */}
        {reservation.timeline && reservation.timeline.length > 0 && (
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-4 space-y-3">
            <h4 className="text-xs font-bold uppercase tracking-wider text-slate-500">Activity Timeline</h4>
            <div className="relative pl-4 space-y-3 border-l-2 border-slate-200 dark:border-slate-800">
              {reservation.timeline.map((event, idx) => (
                <div key={idx} className="relative">
                  <div className="absolute -left-[21px] top-1 h-2.5 w-2.5 rounded-full bg-indigo-600"></div>
                  <div className="text-xs font-semibold text-slate-800 dark:text-slate-200">{event.action}</div>
                  <div className="text-[11px] text-slate-500">
                    {event.actor} • {formatDate(event.timestamp, 'd MMM, h:mm a')}
                  </div>
                  {event.details && <p className="text-xs text-slate-500 mt-0.5">{event.details}</p>}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </Drawer>
  );
}
