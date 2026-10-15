'use client';

import React from 'react';
import { PropertySelector } from './PropertySelector';
import { Menu, Plus, Bell, RefreshCw } from 'lucide-react';
import { Button } from '../ui/button';
import { useProperty } from '@/lib/auth/property-context';

export function Topbar({
  onMenuClick,
  onNewReservation,
}: {
  onMenuClick?: () => void;
  onNewReservation?: () => void;
}) {
  const { reloadProperties, isLoading } = useProperty();

  return (
    <header className="sticky top-0 z-30 flex h-16 w-full items-center justify-between border-b border-slate-200/80 bg-white/90 px-4 sm:px-6 backdrop-blur-md dark:border-slate-800 dark:bg-slate-900/90 transition-all">
      <div className="flex items-center gap-3">
        <button
          onClick={onMenuClick}
          className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-800 dark:hover:bg-slate-800 lg:hidden cursor-pointer"
        >
          <Menu className="h-5 w-5" />
          <span className="sr-only">Toggle Sidebar</span>
        </button>

        {/* Active Property Switcher */}
        <PropertySelector />

        {/* Live Channel Sync indicator */}
        <div className="hidden md:flex items-center gap-2 rounded-full bg-emerald-50 px-2.5 py-1 text-[11px] font-medium text-emerald-700 border border-emerald-200/60 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800/40">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
            <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
          </span>
          OTAs & Channels Synced
        </div>
      </div>

      <div className="flex items-center gap-2.5">
        <button
          onClick={() => reloadProperties()}
          title="Refresh Data"
          className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200 transition-colors cursor-pointer"
        >
          <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
        </button>

        <div className="relative">
          <button
            title="Notifications"
            className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200 transition-colors cursor-pointer"
          >
            <Bell className="h-4 w-4" />
            <span className="absolute top-1.5 right-1.5 h-2 w-2 rounded-full bg-indigo-600"></span>
          </button>
        </div>

        {onNewReservation && (
          <Button
            size="sm"
            onClick={onNewReservation}
            className="shadow-sm font-semibold"
          >
            <Plus className="h-4 w-4 mr-1" />
            <span className="hidden sm:inline">New Reservation</span>
            <span className="sm:hidden">Book</span>
          </Button>
        )}
      </div>
    </header>
  );
}
