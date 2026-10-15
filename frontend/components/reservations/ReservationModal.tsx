'use client';

import React, { useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Dialog } from '../ui/dialog';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Select } from '../ui/select';
import { Alert } from '../ui/alert';
import { ErrorState } from '../ui/query-state';
import { useProperty } from '@/lib/auth/property-context';
import { reservationsApi } from '@/lib/api/reservations';
import { roomTypesApi } from '@/lib/api/room-types';
import { ratesApi } from '@/lib/api/rates';
import { formatISODate } from '@/lib/utils/dates';
import { errorMessage } from '@/lib/utils/errors';
import { addDays } from 'date-fns';

const initialForm = () => ({
  firstName: '',
  lastName: '',
  email: '',
  phone: '',
  roomTypeId: '',
  ratePlanId: '',
  checkIn: formatISODate(new Date()),
  checkOut: formatISODate(addDays(new Date(), 2)),
  adults: 2,
  children: 0,
  source: 'WALK_IN',
  specialRequests: '',
});

export function ReservationModal({
  isOpen,
  onClose,
  onSuccess,
}: {
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: () => void;
}) {
  const { activeProperty } = useProperty();
  const queryClient = useQueryClient();
  const propertyId = activeProperty?._id;
  const [isSubmitting, setIsSubmitting] = useState(false);
  const submitting = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [formData, setFormData] = useState(initialForm);

  const roomTypes = useQuery({
    queryKey: ['room-types', propertyId],
    queryFn: () => roomTypesApi.list(propertyId as string),
    enabled: isOpen && !!propertyId,
  });
  const ratePlans = useQuery({
    queryKey: ['rate-plans', propertyId],
    queryFn: () => ratesApi.listRatePlans(propertyId as string),
    enabled: isOpen && !!propertyId,
  });

  const activeRoomTypes = useMemo(() => (roomTypes.data ?? []).filter((rt) => rt.status === 'ACTIVE'), [roomTypes.data]);
  const roomTypeId = formData.roomTypeId || activeRoomTypes[0]?._id || '';
  const plansForType = useMemo(
    () => (ratePlans.data ?? []).filter((rp) => rp.roomTypeId === roomTypeId && rp.isActive),
    [ratePlans.data, roomTypeId]
  );
  const ratePlanId = plansForType.some((p) => p._id === formData.ratePlanId) ? formData.ratePlanId : plansForType[0]?._id || '';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting.current || !propertyId || !roomTypeId || !ratePlanId) return; // block duplicate submits
    submitting.current = true;
    setIsSubmitting(true);
    setError(null);

    try {
      await reservationsApi.create({
        propertyId,
        guest: {
          firstName: formData.firstName.trim(),
          lastName: formData.lastName.trim(),
          email: formData.email.trim() || undefined,
          phone: formData.phone.replace(/[\s-]/g, '') || undefined, // backend expects E.164
        },
        checkIn: formData.checkIn,
        checkOut: formData.checkOut,
        adults: Number(formData.adults),
        children: Number(formData.children),
        rooms: [{ roomTypeId, ratePlanId, quantity: 1 }],
        source: formData.source,
        specialRequests: formData.specialRequests.trim() || undefined,
      });

      await queryClient.invalidateQueries({ queryKey: ['reservations'] });
      await queryClient.invalidateQueries({ queryKey: ['calendar'] });
      await queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      setFormData(initialForm());
      onSuccess?.();
      onClose();
    } catch (err) {
      // The form keeps everything the user typed so they can fix it and resubmit.
      setError(errorMessage(err));
    } finally {
      submitting.current = false;
      setIsSubmitting(false);
    }
  };

  const loadFailed = roomTypes.isError ? roomTypes : ratePlans.isError ? ratePlans : null;

  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      title="Create New Reservation"
      description={`Direct staff booking for ${activeProperty?.name || 'your property'}`}
      maxWidth="lg"
    >
      {!propertyId ? (
        <Alert variant="warning" message="Create or select a property before adding reservations." />
      ) : loadFailed ? (
        <ErrorState error={loadFailed.error} onRetry={() => void loadFailed.refetch()} />
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4">
          {error && <Alert variant="danger" title="Could not create the reservation" message={error} />}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Input
              label="First Name *"
              required
              value={formData.firstName}
              onChange={(e) => setFormData({ ...formData, firstName: e.target.value })}
              placeholder="e.g. Anand"
            />
            <Input
              label="Last Name"
              value={formData.lastName}
              onChange={(e) => setFormData({ ...formData, lastName: e.target.value })}
              placeholder="e.g. Joshi"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Input
              label="Phone Number (with country code)"
              type="tel"
              value={formData.phone}
              onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
              placeholder="+919876543210"
              helperText="E.164 format, e.g. +919876543210"
            />
            <Input
              label="Email Address"
              type="email"
              value={formData.email}
              onChange={(e) => setFormData({ ...formData, email: e.target.value })}
              placeholder="guest@example.com"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Input
              label="Check-in Date *"
              type="date"
              required
              value={formData.checkIn}
              onChange={(e) => setFormData({ ...formData, checkIn: e.target.value })}
            />
            <Input
              label="Check-out Date *"
              type="date"
              required
              min={formData.checkIn}
              value={formData.checkOut}
              onChange={(e) => setFormData({ ...formData, checkOut: e.target.value })}
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Select
              label="Room Type *"
              value={roomTypeId}
              disabled={roomTypes.isLoading}
              onChange={(e) => setFormData({ ...formData, roomTypeId: e.target.value, ratePlanId: '' })}
              options={activeRoomTypes.map((rt) => ({
                value: rt._id,
                label: `${rt.name} (Max ${rt.maxOccupancy})`,
              }))}
            />
            <Select
              label="Rate Plan *"
              value={ratePlanId}
              disabled={ratePlans.isLoading || plansForType.length === 0}
              onChange={(e) => setFormData({ ...formData, ratePlanId: e.target.value })}
              options={plansForType.map((rp) => ({ value: rp._id, label: rp.name }))}
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Select
              label="Booking Source"
              value={formData.source}
              onChange={(e) => setFormData({ ...formData, source: e.target.value })}
              options={[
                { value: 'WALK_IN', label: 'Walk-In' },
                { value: 'PHONE', label: 'Phone Call' },
                { value: 'DIRECT', label: 'Direct Desk' },
                { value: 'AGENT', label: 'Travel Agent' },
              ]}
            />
            <Input
              label="Adults"
              type="number"
              min={1}
              max={10}
              value={formData.adults}
              onChange={(e) => setFormData({ ...formData, adults: Number(e.target.value) })}
            />
            <Input
              label="Children"
              type="number"
              min={0}
              max={6}
              value={formData.children}
              onChange={(e) => setFormData({ ...formData, children: Number(e.target.value) })}
            />
          </div>

          <Input
            label="Special Requests / Notes"
            value={formData.specialRequests}
            onChange={(e) => setFormData({ ...formData, specialRequests: e.target.value })}
            placeholder="e.g. Ground floor requested, early morning check-in"
          />

          <div className="flex justify-end gap-2.5 pt-3 border-t border-slate-100 dark:border-slate-800">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" isLoading={isSubmitting} disabled={isSubmitting || !roomTypeId || !ratePlanId}>
              Confirm & Reserve
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
