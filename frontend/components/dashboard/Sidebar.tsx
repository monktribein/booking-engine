'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils/cn';
import {
  LayoutDashboard,
  Calendar,
  BookOpen,
  BedDouble,
  Boxes,
  Percent,
  Radio,
  Users,
  CreditCard,
  BarChart3,
  Settings,
  ExternalLink,
  Code2,
  LogOut,
  Hotel,
} from 'lucide-react';
import { useAuth } from '@/lib/auth/auth-context';
import { useProperty } from '@/lib/auth/property-context';

export function Sidebar({ isOpen, onClose }: { isOpen?: boolean; onClose?: () => void }) {
  const pathname = usePathname();
  const { user, logout } = useAuth();
  const { activeProperty } = useProperty();

  const navigation = [
    { name: 'Dashboard', href: '/dashboard', icon: LayoutDashboard },
    { name: 'Calendar', href: '/dashboard/calendar', icon: Calendar },
    { name: 'Reservations', href: '/dashboard/reservations', icon: BookOpen },
    { name: 'Rooms & Types', href: '/dashboard/rooms', icon: BedDouble },
    { name: 'Inventory', href: '/dashboard/inventory', icon: Boxes },
    { name: 'Rates & Plans', href: '/dashboard/rates', icon: Percent },
    { name: 'Channel Manager', href: '/dashboard/channels', icon: Radio },
    { name: 'Guests', href: '/dashboard/guests', icon: Users },
    { name: 'Payments', href: '/dashboard/payments', icon: CreditCard },
    { name: 'Reports', href: '/dashboard/reports', icon: BarChart3 },
    { name: 'Settings', href: '/dashboard/settings', icon: Settings },
    // API keys and webhooks are organization-level: owners (and developers, who see only this) manage them.
    ...(user?.role === 'PROPERTY_OWNER' ? [{ name: 'Developers', href: '/dashboard/developers', icon: Code2 }] : []),
  ];
  const published = !!activeProperty && (activeProperty.directBookingEnabled || activeProperty.marketplaceStatus === 'APPROVED');

  return (
    <>
      {/* Mobile backdrop */}
      {isOpen && (
        <div
          className="fixed inset-0 z-40 bg-slate-900/30 backdrop-blur-xs lg:hidden"
          onClick={onClose}
        />
      )}

      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-50 flex w-64 flex-col border-r border-stone-200 bg-white transition-transform duration-200 ease-in-out lg:static lg:translate-x-0',
          isOpen ? 'translate-x-0' : '-translate-x-full'
        )}
      >
        {/* Brand Header */}
        <div className="flex h-16 shrink-0 items-center justify-between border-b border-stone-100 px-5">
          <Link href="/dashboard" className="flex items-center gap-2.5 group">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#c1d8f0] text-slate-900 border border-[#a8c6e5] transition-transform group-hover:scale-105">
              <Hotel className="h-5 w-5" />
            </div>
            <div className="flex flex-col">
              <span className="text-base font-bold tracking-tight text-slate-900">
                Tirvona
              </span>
              <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                Hospitality PMS
              </span>
            </div>
          </Link>
        </div>

        {/* Navigation Links */}
        <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-4">
          <div className="px-3 pb-2 text-[10px] font-bold uppercase tracking-wider text-slate-500">
            PMS Operations
          </div>
          {navigation.map((item) => {
            const isActive =
              item.href === '/dashboard'
                ? pathname === '/dashboard'
                : pathname.startsWith(item.href);

            const Icon = item.icon;

            return (
              <Link
                key={item.name}
                href={item.href}
                onClick={onClose}
                className={cn(
                  'group flex items-center gap-3 rounded-xl px-3 py-2 text-xs font-medium transition-all duration-150',
                  isActive
                    ? 'bg-[#c1d8f0]/40 text-slate-900 font-bold border border-[#a8c6e5]/60'
                    : 'text-slate-600 hover:bg-stone-100 hover:text-slate-900'
                )}
              >
                <Icon
                  className={cn(
                    'h-4 w-4 shrink-0 transition-colors',
                    isActive ? 'text-slate-900' : 'text-slate-500 group-hover:text-slate-700'
                  )}
                />
                <span>{item.name}</span>
              </Link>
            );
          })}

          <div className="pt-4 px-3 pb-2 text-[10px] font-bold uppercase tracking-wider text-slate-500">
            Direct Experience
          </div>
          {published ? (
          <Link
            href={`/stays/${activeProperty!.slug}`}
            target="_blank"
            className="group flex items-center justify-between rounded-xl px-3 py-2 text-xs font-semibold text-slate-800 bg-stone-50 hover:bg-[#c1d8f0]/30 border border-stone-200/80 hover:border-[#a8c6e5] transition-all"
          >
            <span className="flex items-center gap-2">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500"></span>
              Guest Booking Engine
            </span>
            <ExternalLink className="h-3.5 w-3.5 text-slate-500 group-hover:text-slate-800 transition-colors" />
          </Link>
          ) : (
            <Link
              href="/dashboard/settings?tab=visibility"
              onClick={onClose}
              className="flex items-center justify-between rounded-lg px-3 py-2 text-xs font-medium text-amber-700 bg-amber-50/70 hover:bg-amber-100/70 dark:bg-amber-950/30 dark:text-amber-300 transition-colors"
            >
              <span>Not published yet: set visibility</span>
            </Link>
          )}
        </nav>

        {/* User Profile & Sign Out Footer */}
        <div className="border-t border-stone-100 p-3">
          <div className="flex items-center justify-between rounded-2xl bg-stone-50 border border-stone-200/60 p-2.5">
            <Link href="/dashboard/profile" onClick={onClose} title="Your profile" className="flex items-center gap-2.5 min-w-0 rounded-lg">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-[#c1d8f0] text-slate-900 font-bold text-xs border border-[#a8c6e5]">
                {user?.name ? user.name[0].toUpperCase() : 'O'}
              </div>
              <div className="flex flex-col truncate">
                <span className="text-xs font-bold text-slate-900 truncate">
                  {user?.name ?? 'Hotel Owner'}
                </span>
                <span className="text-[10px] text-slate-500 capitalize truncate">
                  {user?.role ? user.role.replace('_', ' ').toLowerCase() : 'Owner'}
                </span>
              </div>
            </Link>

            <button
              onClick={() => logout()}
              title="Sign Out"
              className="rounded-xl p-1.5 text-slate-500 hover:bg-stone-200 hover:text-slate-800 transition-colors cursor-pointer"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}
