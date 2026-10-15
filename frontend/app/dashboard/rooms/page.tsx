'use client';

import React, { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PhysicalRoom, RoomStatus, RoomType } from '@/types';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Alert } from '@/components/ui/alert';
import { EmptyState, NoPropertyState, QueryState } from '@/components/ui/query-state';
import { useProperty } from '@/lib/auth/property-context';
import { formatCurrency } from '@/lib/utils/currency';
import { errorMessage } from '@/lib/utils/errors';
import { getRoomStatusBadge } from '@/lib/utils/formatters';
import { roomsApi } from '@/lib/api/rooms';
import { roomTypesApi } from '@/lib/api/room-types';
import { Plus, Edit } from 'lucide-react';

/** Statuses the backend lets staff set (OCCUPIED is driven by check-in / check-out). */
const SETTABLE_STATUSES = [RoomStatus.AVAILABLE, RoomStatus.CLEANING, RoomStatus.MAINTENANCE, RoomStatus.BLOCKED];

interface RoomsData {
  roomTypes: RoomType[];
  rooms: PhysicalRoom[];
}

export default function RoomsManagementPage() {
  const { activeProperty, error: propertyError, reloadProperties, isLoading: propertyLoading } = useProperty();
  const propertyId = activeProperty?._id;
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<string>('all');
  const [formError, setFormError] = useState<string | null>(null);

  // Room types and their rooms are loaded together so a partial result is never shown as complete.
  const query = useQuery<RoomsData>({
    queryKey: ['rooms', propertyId],
    queryFn: async () => {
      const roomTypes = await roomTypesApi.list(propertyId as string);
      const rooms = (await Promise.all(roomTypes.map((rt) => roomsApi.listByRoomType(rt._id)))).flat();
      return { roomTypes, rooms };
    },
    enabled: !!propertyId,
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['rooms', propertyId] });

  // Room status
  const [statusRoom, setStatusRoom] = useState<PhysicalRoom | null>(null);
  const [newStatus, setNewStatus] = useState<RoomStatus>(RoomStatus.AVAILABLE);
  const [statusNotes, setStatusNotes] = useState('');
  const [blockUntil, setBlockUntil] = useState('');
  const statusMutation = useMutation({
    mutationFn: () =>
      roomsApi.changeStatus(statusRoom!._id, {
        status: newStatus,
        notes: statusNotes.trim() || undefined,
        blockUntil: blockUntil || undefined,
      }),
    onSuccess: async () => {
      setStatusRoom(null);
      setFormError(null);
      await refresh();
    },
    onError: (e) => setFormError(errorMessage(e)),
  });

  // Room type create / edit
  const [typeOpen, setTypeOpen] = useState(false);
  const [editingType, setEditingType] = useState<RoomType | null>(null);
  const [typeName, setTypeName] = useState('');
  const [typeSlug, setTypeSlug] = useState('');
  const [typePrice, setTypePrice] = useState(2500);
  const [typeOccupancy, setTypeOccupancy] = useState(2);
  const [typeAmenities, setTypeAmenities] = useState('Wi-Fi, Hot Water');
  const typeMutation = useMutation({
    mutationFn: () => {
      const body = {
        name: typeName.trim(),
        slug: typeSlug.trim() || undefined,
        basePrice: Math.round(typePrice * 100),
        maxOccupancy: Number(typeOccupancy),
        amenities: typeAmenities.split(',').map((s) => s.trim()).filter(Boolean),
      };
      return editingType ? roomTypesApi.update(editingType._id, body) : roomTypesApi.create(propertyId as string, body);
    },
    onSuccess: async () => {
      setTypeOpen(false);
      setFormError(null);
      await refresh();
    },
    onError: (e) => setFormError(errorMessage(e)),
  });
  const archiveMutation = useMutation({
    mutationFn: (id: string) => roomTypesApi.archive(id),
    onSuccess: refresh,
    onError: (e) => setFormError(errorMessage(e)),
  });

  // Add physical room
  const [addOpen, setAddOpen] = useState(false);
  const [targetTypeId, setTargetTypeId] = useState('');
  const [newRoomNumber, setNewRoomNumber] = useState('');
  const [newRoomFloor, setNewRoomFloor] = useState('1');
  const addRoomMutation = useMutation({
    mutationFn: () => roomsApi.create(targetTypeId || query.data!.roomTypes[0]._id, { roomNumber: newRoomNumber.trim(), floor: newRoomFloor.trim() || undefined }),
    onSuccess: async () => {
      setNewRoomNumber('');
      setAddOpen(false);
      setFormError(null);
      await refresh();
    },
    onError: (e) => setFormError(errorMessage(e)),
  });

  const openStatus = (room: PhysicalRoom) => {
    setFormError(null);
    setStatusRoom(room);
    setNewStatus(SETTABLE_STATUSES.includes(room.status) ? room.status : RoomStatus.AVAILABLE);
    setStatusNotes(room.cleaningNotes || '');
    setBlockUntil('');
  };

  const openType = (rt?: RoomType) => {
    setFormError(null);
    setEditingType(rt ?? null);
    setTypeName(rt?.name ?? '');
    setTypeSlug(rt?.slug ?? '');
    setTypePrice(rt ? rt.basePrice / 100 : 2500);
    setTypeOccupancy(rt?.maxOccupancy ?? 2);
    setTypeAmenities(rt ? rt.amenities.join(', ') : 'Wi-Fi, Hot Water');
    setTypeOpen(true);
  };

  if (!propertyId) {
    return propertyLoading ? null : <NoPropertyState error={propertyError} onRetry={() => void reloadProperties()} />;
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">Room Types & Physical Rooms</h1>
          <p className="text-xs sm:text-sm text-slate-500 dark:text-slate-400">
            Configure room categories, pricing, capacities, and live housekeeping statuses.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={!query.data?.roomTypes.length}
            onClick={() => {
              setFormError(null);
              setAddOpen(true);
            }}
          >
            <Plus className="h-4 w-4 mr-1.5" /> Add Room #
          </Button>
          <Button size="sm" onClick={() => openType()}>
            <Plus className="h-4 w-4 mr-1.5" /> New Room Type
          </Button>
        </div>
      </div>

      {formError && !statusRoom && !typeOpen && !addOpen && <Alert variant="danger" message={formError} onClose={() => setFormError(null)} />}

      <QueryState
        query={query}
        data={query.data}
        isEmpty={(d) => d.roomTypes.length === 0}
        empty={<EmptyState title="No room types yet" hint="Create your first room type to start adding rooms." action={<Button size="sm" onClick={() => openType()}>New Room Type</Button>} />}
      >
        {({ roomTypes, rooms }) => {
          const filtered = activeTab === 'all' ? rooms : rooms.filter((r) => r.roomTypeId === activeTab);
          return (
            <>
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h2 className="text-base font-bold text-slate-900 dark:text-slate-100">Room Types</h2>
                  <span className="text-xs text-slate-400">{roomTypes.length} configured</span>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
                  {roomTypes.map((rt) => {
                    const roomsOfType = rooms.filter((r) => r.roomTypeId === rt._id);
                    const availableCount = roomsOfType.filter((r) => r.status === RoomStatus.AVAILABLE).length;
                    return (
                      <Card key={rt._id} className="relative overflow-hidden hover:shadow-md transition-all">
                        <CardHeader className="pb-2">
                          <div className="flex items-start justify-between">
                            <div>
                              <CardTitle className="text-base font-bold">{rt.name}</CardTitle>
                              <CardDescription>Max {rt.maxOccupancy} Guests Capacity</CardDescription>
                            </div>
                            <div className="text-right">
                              <div className="text-base font-extrabold text-indigo-600 dark:text-indigo-400">{formatCurrency(rt.basePrice, rt.currency)}</div>
                              <span className="text-[10px] text-slate-400">base / night</span>
                            </div>
                          </div>
                        </CardHeader>
                        <CardContent className="space-y-4 pt-2">
                          <div className="flex items-center justify-between p-2.5 rounded-lg bg-slate-50 dark:bg-slate-800/60 text-xs">
                            <div>
                              <span className="text-slate-400 block text-[10px]">Total Inventory</span>
                              <span className="font-bold text-slate-800 dark:text-slate-200">{roomsOfType.length} Rooms</span>
                            </div>
                            <div className="text-right">
                              <span className="text-slate-400 block text-[10px]">Ready & Available</span>
                              <span className="font-bold text-emerald-600 dark:text-emerald-400">{availableCount} Available</span>
                            </div>
                          </div>
                          <div>
                            <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 block mb-1.5">Included Amenities</span>
                            <div className="flex flex-wrap gap-1">
                              {rt.amenities.map((amenity, i) => (
                                <span key={i} className="rounded-md bg-slate-100 dark:bg-slate-800 px-2 py-0.5 text-[11px] font-medium text-slate-600 dark:text-slate-300">
                                  {amenity}
                                </span>
                              ))}
                            </div>
                          </div>
                          <div className="pt-3 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between">
                            <Button variant="ghost" size="sm" onClick={() => openType(rt)} className="h-8 px-2.5 text-xs text-slate-600">
                              <Edit className="h-3.5 w-3.5 mr-1" /> Edit Type
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={archiveMutation.isPending}
                              onClick={() => {
                                if (window.confirm(`Archive room type "${rt.name}"? It stops being sold.`)) archiveMutation.mutate(rt._id);
                              }}
                              className="h-8 px-2.5 text-xs text-rose-600 hover:text-rose-700"
                            >
                              Archive
                            </Button>
                          </div>
                        </CardContent>
                      </Card>
                    );
                  })}
                </div>
              </div>

              <div className="space-y-4">
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                  <div>
                    <h2 className="text-base font-bold text-slate-900 dark:text-slate-100">Physical Rooms & Housekeeping Status</h2>
                    <p className="text-xs text-slate-500">Select a room to change its operational status.</p>
                  </div>
                  <div className="flex items-center gap-1 overflow-x-auto bg-slate-100 dark:bg-slate-800 p-1 rounded-lg text-xs" role="tablist" aria-label="Filter rooms by type">
                    <button
                      role="tab"
                      aria-selected={activeTab === 'all'}
                      onClick={() => setActiveTab('all')}
                      className={`px-3 py-1 rounded-md font-medium cursor-pointer transition-colors ${activeTab === 'all' ? 'bg-white dark:bg-slate-700 text-slate-900 font-bold shadow-xs' : 'text-slate-600'}`}
                    >
                      All ({rooms.length})
                    </button>
                    {roomTypes.map((rt) => (
                      <button
                        key={rt._id}
                        role="tab"
                        aria-selected={activeTab === rt._id}
                        onClick={() => setActiveTab(rt._id)}
                        className={`px-3 py-1 rounded-md font-medium cursor-pointer transition-colors whitespace-nowrap ${activeTab === rt._id ? 'bg-white dark:bg-slate-700 text-slate-900 font-bold shadow-xs' : 'text-slate-600'}`}
                      >
                        {rt.name}
                      </button>
                    ))}
                  </div>
                </div>

                {filtered.length === 0 ? (
                  <EmptyState title="No rooms" hint="Add physical rooms to this room type." />
                ) : (
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 lg:grid-cols-6 gap-3">
                    {filtered.map((room) => {
                      const badge = getRoomStatusBadge(room.status);
                      const rt = roomTypes.find((t) => t._id === room.roomTypeId);
                      return (
                        <button
                          key={room._id}
                          type="button"
                          onClick={() => openStatus(room)}
                          aria-label={`Room ${room.roomNumber}, ${badge.label}. Change status`}
                          className="group relative flex flex-col justify-between p-3.5 rounded-xl border border-slate-200/80 dark:border-slate-800 bg-white dark:bg-slate-900 hover:border-indigo-400 hover:shadow-md transition-all cursor-pointer text-left focus-visible:outline-2 focus-visible:outline-indigo-600"
                        >
                          <div className="flex items-center justify-between mb-2 w-full">
                            <span className="text-lg font-bold text-slate-900 dark:text-slate-100">{room.roomNumber}</span>
                            <span className={`h-2.5 w-2.5 rounded-full ${badge.dot}`} />
                          </div>
                          <div className="text-[11px] text-slate-500 truncate mb-2">
                            {rt?.name || 'Room'} • Fl {room.floor || '-'}
                          </div>
                          <div className={`mt-auto w-full px-2 py-1 rounded-md text-[10px] font-semibold text-center ${badge.bg} ${badge.text}`}>{badge.label}</div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </>
          );
        }}
      </QueryState>

      {/* Room status dialog */}
      <Dialog
        isOpen={!!statusRoom}
        onClose={() => setStatusRoom(null)}
        title={`Change Status - Room ${statusRoom?.roomNumber || ''}`}
        description="Rooms set to Maintenance or Blocked are taken out of sellable inventory by the server."
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!statusMutation.isPending) statusMutation.mutate();
          }}
          className="space-y-4"
        >
          {formError && <Alert variant="danger" message={formError} />}
          {statusRoom?.status === RoomStatus.OCCUPIED && (
            <Alert variant="info" message="This room is occupied by a checked-in guest. Check the guest out from Reservations to release it." />
          )}
          <Select
            label="Operational Status *"
            value={newStatus}
            onChange={(e) => setNewStatus(e.target.value as RoomStatus)}
            options={SETTABLE_STATUSES.map((s) => ({ value: s, label: s }))}
          />
          <Input label="Notes" placeholder="e.g. Geyser inspection needed" value={statusNotes} onChange={(e) => setStatusNotes(e.target.value)} />
          {(newStatus === RoomStatus.MAINTENANCE || newStatus === RoomStatus.BLOCKED) && (
            <Input label="Out of service until (optional)" type="date" value={blockUntil} onChange={(e) => setBlockUntil(e.target.value)} />
          )}
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => setStatusRoom(null)}>
              Cancel
            </Button>
            <Button type="submit" isLoading={statusMutation.isPending} disabled={statusMutation.isPending || statusRoom?.status === RoomStatus.OCCUPIED}>
              Save Room Status
            </Button>
          </div>
        </form>
      </Dialog>

      {/* Room type dialog */}
      <Dialog
        isOpen={typeOpen}
        onClose={() => setTypeOpen(false)}
        title={editingType ? `Edit ${editingType.name}` : 'Create Room Type'}
        description="Room types are the categories sold on Tirvona and mapped to OTA channels. The room count follows the physical rooms you add."
        maxWidth="lg"
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!typeMutation.isPending) typeMutation.mutate();
          }}
          className="space-y-4"
        >
          {formError && <Alert variant="danger" message={formError} />}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Input label="Room Type Name *" required value={typeName} onChange={(e) => setTypeName(e.target.value)} placeholder="e.g. Deluxe AC" />
            <Input label="URL Slug" value={typeSlug} onChange={(e) => setTypeSlug(e.target.value)} placeholder="deluxe-ac (optional)" />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Input label="Base Price (₹/Night) *" type="number" required min={1} value={typePrice} onChange={(e) => setTypePrice(Number(e.target.value))} />
            <Input label="Max Occupancy (Guests) *" type="number" required min={1} value={typeOccupancy} onChange={(e) => setTypeOccupancy(Number(e.target.value))} />
          </div>
          <Input label="Amenities (comma separated)" value={typeAmenities} onChange={(e) => setTypeAmenities(e.target.value)} />
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => setTypeOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" isLoading={typeMutation.isPending} disabled={typeMutation.isPending}>
              {editingType ? 'Update Room Type' : 'Create Room Type'}
            </Button>
          </div>
        </form>
      </Dialog>

      {/* Add physical room dialog */}
      <Dialog isOpen={addOpen} onClose={() => setAddOpen(false)} title="Add Physical Room Number" description="Creates a physical room under a room type.">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!addRoomMutation.isPending) addRoomMutation.mutate();
          }}
          className="space-y-4"
        >
          {formError && <Alert variant="danger" message={formError} />}
          <Select
            label="Select Room Type *"
            value={targetTypeId || query.data?.roomTypes[0]?._id || ''}
            onChange={(e) => setTargetTypeId(e.target.value)}
            options={(query.data?.roomTypes ?? []).map((rt) => ({ value: rt._id, label: rt.name }))}
          />
          <div className="grid grid-cols-2 gap-3">
            <Input label="Room Number *" required placeholder="e.g. 111" value={newRoomNumber} onChange={(e) => setNewRoomNumber(e.target.value)} />
            <Input label="Floor" placeholder="e.g. 1" value={newRoomFloor} onChange={(e) => setNewRoomFloor(e.target.value)} />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => setAddOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" isLoading={addRoomMutation.isPending} disabled={addRoomMutation.isPending}>
              Add Room
            </Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}
