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
  LogOut,
  Sparkles,
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
  ];

  return (
    <>
      {/* Mobile backdrop */}
      {isOpen && (
        <div
          className="fixed inset-0 z-40 bg-slate-900/60 backdrop-blur-xs lg:hidden"
          onClick={onClose}
        />
      )}

      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-50 flex w-64 flex-col border-r border-slate-200/80 bg-white dark:border-slate-800 dark:bg-slate-900 transition-transform duration-200 ease-in-out lg:static lg:translate-x-0',
          isOpen ? 'translate-x-0' : '-translate-x-full'
        )}
      >
        {/* Brand Header */}
        <div className="flex h-16 shrink-0 items-center justify-between border-b border-slate-200/80 px-5 dark:border-slate-800">
          <Link href="/dashboard" className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-tr from-indigo-600 to-violet-500 text-white shadow-md shadow-indigo-500/20">
              <Sparkles className="h-5 w-5" />
            </div>
            <div className="flex flex-col">
              <span className="text-base font-bold tracking-tight text-slate-900 dark:text-white">
                Tirvona
              </span>
              <span className="text-[10px] font-semibold uppercase tracking-widest text-indigo-600 dark:text-indigo-400">
                Hospitality PMS
              </span>
            </div>
          </Link>
        </div>

        {/* Navigation Links */}
        <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-4">
          <div className="px-3 pb-2 text-[10px] font-bold uppercase tracking-wider text-slate-400">
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
                  'group flex items-center gap-3 rounded-lg px-3 py-2 text-xs font-medium transition-all duration-150',
                  isActive
                    ? 'bg-indigo-50 text-indigo-700 font-semibold dark:bg-indigo-950/50 dark:text-indigo-300 shadow-2xs'
                    : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800/80 dark:hover:text-slate-100'
                )}
              >
                <Icon
                  className={cn(
                    'h-4 w-4 shrink-0 transition-colors',
                    isActive
                      ? 'text-indigo-600 dark:text-indigo-400'
                      : 'text-slate-400 group-hover:text-slate-600 dark:text-slate-500 dark:group-hover:text-slate-300'
                  )}
                />
                <span>{item.name}</span>
              </Link>
            );
          })}

          <div className="pt-4 px-3 pb-2 text-[10px] font-bold uppercase tracking-wider text-slate-400">
            Direct Experience
          </div>
          <Link
            href={activeProperty ? `/stays/${activeProperty.slug}` : '/dashboard'}
            target="_blank"
            className="group flex items-center justify-between rounded-lg px-3 py-2 text-xs font-medium text-emerald-700 bg-emerald-50/70 hover:bg-emerald-100/70 dark:bg-emerald-950/30 dark:text-emerald-300 dark:hover:bg-emerald-950/50 transition-colors"
          >
            <span className="flex items-center gap-2">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
              </span>
              Guest Booking Engine
            </span>
            <ExternalLink className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
          </Link>
        </nav>

        {/* User Profile & Sign Out Footer */}
        <div className="border-t border-slate-200/80 p-3 dark:border-slate-800">
          <div className="flex items-center justify-between rounded-xl bg-slate-50 p-2.5 dark:bg-slate-800/50">
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-indigo-600 font-bold text-xs text-white">
                {user?.name ? user.name[0].toUpperCase() : 'O'}
              </div>
              <div className="flex flex-col truncate">
                <span className="text-xs font-semibold text-slate-900 dark:text-slate-100 truncate">
                  {user?.name ?? ''}
                </span>
                <span className="text-[10px] text-slate-400 capitalize truncate">
                  {user?.role ? user.role.replace('_', ' ').toLowerCase() : 'Owner'}
                </span>
              </div>
            </div>

            <button
              onClick={() => logout()}
              title="Sign Out"
              className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-200 hover:text-slate-700 dark:hover:bg-slate-700 dark:hover:text-slate-200 transition-colors cursor-pointer"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}
