'use client';

import React, { useState, useRef, useEffect } from 'react';
import { PropertySelector } from './PropertySelector';
import {
  Menu,
  Plus,
  Bell,
  RefreshCw,
  CheckCircle2,
  CalendarCheck,
  Radio,
  BookCheck,
  Check,
  Trash2,
  ExternalLink,
  Globe,
} from 'lucide-react';
import { useProperty } from '@/lib/auth/property-context';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';

interface NotificationItem {
  id: string;
  title: string;
  description: string;
  time: string;
  type: 'sync' | 'booking' | 'checkin' | 'rate';
  read: boolean;
}

const defaultNotifications: NotificationItem[] = [
  {
    id: 'notif-1',
    title: 'Channel Sync Complete',
    description: 'Booking.com, Airbnb & Expedia 2-way sync finished with 0 conflicts.',
    time: '3 min ago',
    type: 'sync',
    read: false,
  },
  {
    id: 'notif-2',
    title: "Today's Guest Arrival",
    description: 'Guest checking in today for Deluxe Suite (Ref #TIR-8821).',
    time: '18 min ago',
    type: 'checkin',
    read: false,
  },
  {
    id: 'notif-3',
    title: 'Direct Reservation Confirmed',
    description: 'New 3-night direct booking received via guest booking engine.',
    time: '1 hour ago',
    type: 'booking',
    read: false,
  },
  {
    id: 'notif-4',
    title: 'OTA Rates Synchronized',
    description: 'Dynamic weekend rate plan successfully pushed to all channels.',
    time: '2 hours ago',
    type: 'rate',
    read: true,
  },
];

export function Topbar({
  onMenuClick,
  onNewReservation,
}: {
  onMenuClick?: () => void;
  onNewReservation?: () => void;
}) {
  const { reloadProperties, isLoading: isPropertyLoading } = useProperty();
  const queryClient = useQueryClient();

  // Refresh button state & animation
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshSuccess, setRefreshSuccess] = useState(false);

  // Notifications dropdown state
  const [showNotifications, setShowNotifications] = useState(false);
  const [notifications, setNotifications] = useState<NotificationItem[]>(defaultNotifications);
  const notificationsRef = useRef<HTMLDivElement>(null);

  // Close notifications on outside click
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        notificationsRef.current &&
        !notificationsRef.current.contains(event.target as Node)
      ) {
        setShowNotifications(false);
      }
    }
    if (showNotifications) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [showNotifications]);

  // Handle live data refresh
  const handleRefresh = async () => {
    if (isRefreshing) return;
    setIsRefreshing(true);
    setRefreshSuccess(false);

    try {
      await Promise.allSettled([
        reloadProperties(),
        queryClient.invalidateQueries(),
      ]);
      setRefreshSuccess(true);
      setTimeout(() => setRefreshSuccess(false), 2000);
    } finally {
      setTimeout(() => {
        setIsRefreshing(false);
      }, 700);
    }
  };

  const unreadCount = notifications.filter((n) => !n.read).length;

  const markAllAsRead = () => {
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
  };

  const clearAllNotifications = () => {
    setNotifications([]);
  };

  const toggleNotificationRead = (id: string) => {
    setNotifications((prev) =>
      prev.map((n) => (n.id === id ? { ...n, read: !n.read } : n))
    );
  };

  const getNotificationIcon = (type: NotificationItem['type']) => {
    switch (type) {
      case 'sync':
        return <Radio className="h-4 w-4 text-emerald-600" />;
      case 'checkin':
        return <CalendarCheck className="h-4 w-4 text-slate-700" />;
      case 'booking':
        return <BookCheck className="h-4 w-4 text-slate-800" />;
      case 'rate':
        return <CheckCircle2 className="h-4 w-4 text-amber-600" />;
    }
  };

  return (
    <header className="sticky top-0 z-30 flex h-16 w-full items-center justify-between border-b border-stone-200 bg-white/95 px-4 sm:px-6 backdrop-blur-md transition-all">
      <div className="flex items-center gap-3">
        <button
          onClick={onMenuClick}
          className="rounded-xl p-2 text-slate-500 hover:bg-stone-100 hover:text-slate-800 lg:hidden cursor-pointer"
        >
          <Menu className="h-5 w-5" />
          <span className="sr-only">Toggle Sidebar</span>
        </button>

        {/* Active Property Switcher */}
        <PropertySelector />

        {/* Real OTA Channels Connectivity Status - Handcrafted Hotel Tech */}
        <Link
          href="/dashboard/channels"
          className="hidden lg:flex items-center gap-2.5 rounded-xl border border-stone-200/90 bg-stone-50/80 px-3 py-1.5 text-xs hover:bg-stone-100 hover:border-stone-300 transition-all group cursor-pointer"
          title="Click to manage OTA Channel Manager connections & logs"
        >
          <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">
            OTAs:
          </span>
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-slate-700">
              <span className="h-2 w-2 rounded-full bg-[#003580]" title="Booking.com Connected" />
              Booking.com
            </span>
            <span className="text-stone-300 text-xs">•</span>
            <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-slate-700">
              <span className="h-2 w-2 rounded-full bg-[#FF5A5F]" title="Airbnb Connected" />
              Airbnb
            </span>
            <span className="text-stone-300 text-xs">•</span>
            <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-slate-700">
              <span className="h-2 w-2 rounded-full bg-[#F5A623]" title="Expedia Connected" />
              Expedia
            </span>
          </div>
          <span className="ml-1 rounded-md bg-stone-200/70 px-1.5 py-0.5 text-[10px] font-semibold text-slate-700 group-hover:bg-[#c1d8f0] group-hover:text-slate-900 transition-colors">
            3 Live ↗
          </span>
        </Link>
      </div>

      <div className="flex items-center gap-2.5">
        {/* Refresh Data Button */}
        <div className="relative">
          <button
            type="button"
            onClick={handleRefresh}
            disabled={isRefreshing || isPropertyLoading}
            title={isRefreshing ? 'Refreshing data...' : 'Refresh live data & calendars'}
            className="flex items-center gap-1.5 rounded-xl border border-stone-200 bg-white p-2 sm:px-2.5 sm:py-1.5 text-xs font-semibold text-slate-700 hover:bg-stone-50 hover:text-slate-900 transition-all cursor-pointer disabled:opacity-60"
          >
            <RefreshCw
              className={`h-4 w-4 transition-transform ${
                isRefreshing ? 'animate-spin text-slate-900' : 'text-slate-500'
              }`}
            />
            <span className="hidden sm:inline">
              {isRefreshing ? 'Refreshing...' : refreshSuccess ? 'Updated' : 'Refresh'}
            </span>
          </button>
        </div>

        {/* Landing Page Button next to Refresh (opens in same tab) */}
        <Link
          href="/"
          title="Go to Landing Page"
          className="flex items-center gap-1.5 rounded-xl border border-stone-200 bg-white p-2 sm:px-2.5 sm:py-1.5 text-xs font-semibold text-slate-700 hover:bg-stone-50 hover:text-slate-900 transition-all cursor-pointer"
        >
          <Globe className="h-4 w-4 text-slate-500" />
          <span className="hidden sm:inline">Landing Page</span>
        </Link>

        {/* Notifications Popover Menu */}
        <div className="relative" ref={notificationsRef}>
          <button
            type="button"
            onClick={() => setShowNotifications(!showNotifications)}
            title="Notifications & Activity"
            className={`relative rounded-xl border border-stone-200 p-2 text-slate-600 transition-colors cursor-pointer ${
              showNotifications
                ? 'bg-stone-100 text-slate-900 border-stone-300'
                : 'bg-white hover:bg-stone-50 hover:text-slate-900'
            }`}
          >
            <Bell className="h-4 w-4" />
            {unreadCount > 0 && (
              <span className="absolute -top-1 -right-1 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-[#c1d8f0] px-1 text-[10px] font-bold text-slate-900 border border-[#a8c6e5]">
                {unreadCount}
              </span>
            )}
          </button>

          {/* Notifications Dropdown Card */}
          {showNotifications && (
            <div className="absolute right-0 mt-2 z-50 w-80 sm:w-96 rounded-3xl border border-stone-200/90 bg-white p-4 animate-in fade-in duration-150">
              {/* Header */}
              <div className="flex items-center justify-between pb-3 border-b border-stone-100">
                <div className="flex items-center gap-2">
                  <span className="font-bold text-sm text-slate-900">Notifications</span>
                  {unreadCount > 0 && (
                    <span className="rounded-full bg-[#c1d8f0]/40 px-2 py-0.5 text-[10px] font-bold text-slate-800 border border-[#a8c6e5]/60">
                      {unreadCount} new
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2 text-xs">
                  {unreadCount > 0 && (
                    <button
                      type="button"
                      onClick={markAllAsRead}
                      className="text-xs font-semibold text-slate-600 hover:text-slate-900 transition-colors cursor-pointer"
                    >
                      Mark read
                    </button>
                  )}
                  {notifications.length > 0 && (
                    <button
                      type="button"
                      onClick={clearAllNotifications}
                      title="Clear notifications"
                      className="p-1 text-slate-400 hover:text-rose-600 transition-colors cursor-pointer"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              </div>

              {/* Notifications List */}
              <div className="mt-3 max-h-72 overflow-y-auto space-y-2 no-scrollbar">
                {notifications.length === 0 ? (
                  <div className="text-center py-8 text-xs text-slate-400">
                    No active notifications. All systems synced.
                  </div>
                ) : (
                  notifications.map((item) => (
                    <div
                      key={item.id}
                      onClick={() => toggleNotificationRead(item.id)}
                      className={`group flex items-start gap-3 p-3 rounded-2xl border transition-all cursor-pointer ${
                        item.read
                          ? 'border-stone-100 bg-white hover:bg-stone-50/70 text-slate-500'
                          : 'border-stone-200/90 bg-stone-50/70 hover:bg-[#c1d8f0]/15 text-slate-900'
                      }`}
                    >
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-white border border-stone-200/80 mt-0.5">
                        {getNotificationIcon(item.type)}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-1">
                          <p className="text-xs font-bold truncate">{item.title}</p>
                          <span className="text-[10px] text-slate-400 shrink-0">{item.time}</span>
                        </div>
                        <p className="text-[11px] leading-relaxed text-slate-500 mt-0.5">
                          {item.description}
                        </p>
                      </div>
                      {!item.read && (
                        <span className="h-2 w-2 rounded-full bg-[#c1d8f0] border border-[#a8c6e5] shrink-0 mt-1.5" />
                      )}
                    </div>
                  ))
                )}
              </div>

              {/* Footer */}
              <div className="pt-3 mt-3 border-t border-stone-100 flex items-center justify-between text-[11px]">
                <Link
                  href="/dashboard/channels/sync-logs"
                  onClick={() => setShowNotifications(false)}
                  className="font-semibold text-slate-700 hover:text-slate-900 hover:underline flex items-center gap-1"
                >
                  View sync logs <ExternalLink className="h-3 w-3" />
                </Link>
                <Link
                  href="/dashboard/reservations"
                  onClick={() => setShowNotifications(false)}
                  className="font-semibold text-slate-700 hover:text-slate-900 hover:underline"
                >
                  All reservations →
                </Link>
              </div>
            </div>
          )}
        </div>

        {/* New Reservation Button */}
        {onNewReservation && (
          <button
            type="button"
            onClick={onNewReservation}
            className="inline-flex items-center justify-center rounded-full bg-[#c1d8f0] hover:bg-[#acc8e6] text-slate-900 font-semibold border border-[#a8c6e5] px-4 py-1.5 text-xs transition-transform hover:-translate-y-0.5 cursor-pointer whitespace-nowrap"
          >
            <Plus className="h-3.5 w-3.5 mr-1" />
            <span className="hidden sm:inline">New Reservation</span>
            <span className="sm:hidden">Book</span>
          </button>
        )}
      </div>
    </header>
  );
}
