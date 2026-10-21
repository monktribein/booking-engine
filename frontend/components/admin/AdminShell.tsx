'use client';

import React, { useEffect } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Building2, ClipboardList, Globe2, LogOut, Plug, ScrollText, ShieldCheck, Sparkles, Waypoints } from 'lucide-react';
import { Skeleton } from '../ui/skeleton';
import { useAuth } from '@/lib/auth/auth-context';
import { cn } from '@/lib/utils/cn';
import { UserRole } from '@/types';

const NAV = [
  { name: 'Partners', href: '/admin/partners', icon: Building2, superOnly: false },
  { name: 'Marketplace', href: '/admin/marketplace', icon: Globe2, superOnly: false },
  { name: 'Integrations', href: '/admin/integrations', icon: Plug, superOnly: false },
  { name: 'Providers', href: '/admin/providers', icon: Waypoints, superOnly: false },
  { name: 'Operations', href: '/admin/operations', icon: ClipboardList, superOnly: false },
  { name: 'Audit log', href: '/admin/audit', icon: ScrollText, superOnly: true },
] as const;

export const isPlatformRole = (role?: string) => role === UserRole.SUPER_ADMIN || role === UserRole.OPERATIONS_ADMIN;

/** The platform operator's console. Only SUPER_ADMIN and OPERATIONS_ADMIN get in; everyone else is sent to their own dashboard. */
export function AdminShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { user, isLoading, logout } = useAuth();

  useEffect(() => {
    if (isLoading) return;
    if (!user) router.replace('/login');
    else if (!isPlatformRole(user.role)) router.replace('/dashboard');
  }, [isLoading, user, router]);

  if (isLoading || !user || !isPlatformRole(user.role)) {
    return (
      <div className="p-8 space-y-4" aria-busy="true">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const isSuper = user.role === UserRole.SUPER_ADMIN;
  return (
    <div className="flex min-h-screen bg-slate-50/50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 font-sans">
      <aside className="hidden w-60 shrink-0 flex-col border-r border-slate-200/80 bg-white dark:border-slate-800 dark:bg-slate-900 md:flex">
        <div className="flex h-16 items-center gap-2.5 border-b border-slate-200/80 px-5 dark:border-slate-800">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-tr from-indigo-600 to-violet-500 text-white">
            <Sparkles className="h-5 w-5" aria-hidden="true" />
          </div>
          <div className="flex flex-col">
            <span className="text-base font-bold tracking-tight">Tirvona</span>
            <span className="text-[10px] font-semibold uppercase tracking-widest text-indigo-600 dark:text-indigo-400">Platform admin</span>
          </div>
        </div>
        <nav className="flex-1 space-y-1 px-3 py-4" aria-label="Admin sections">
          {NAV.filter((n) => isSuper || !n.superOnly).map((item) => {
            const active = pathname.startsWith(item.href);
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  'flex items-center gap-3 rounded-lg px-3 py-2 text-xs font-medium transition-colors',
                  active ? 'bg-indigo-50 font-semibold text-indigo-700 dark:bg-indigo-950/50 dark:text-indigo-300' : 'text-slate-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800',
                )}
              >
                <Icon className="h-4 w-4" aria-hidden="true" />
                {item.name}
              </Link>
            );
          })}
        </nav>
        <div className="border-t border-slate-200/80 p-3 dark:border-slate-800">
          <div className="flex items-center justify-between rounded-xl bg-slate-50 p-2.5 dark:bg-slate-800/50">
            <div className="min-w-0">
              <div className="truncate text-xs font-semibold">{user.name}</div>
              <div className="flex items-center gap-1 text-[10px] text-slate-500">
                <ShieldCheck className="h-3 w-3" aria-hidden="true" />
                {isSuper ? 'Super admin' : 'Operations'}
              </div>
            </div>
            <button onClick={() => void logout()} title="Sign Out" className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-200 hover:text-slate-700 dark:hover:bg-slate-700 cursor-pointer">
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center justify-between border-b border-slate-200/80 bg-white px-4 dark:border-slate-800 dark:bg-slate-900 md:hidden">
          <span className="text-sm font-bold">Tirvona admin</span>
          <button onClick={() => void logout()} className="text-xs text-slate-500 cursor-pointer">Sign out</button>
        </header>
        <nav className="flex gap-1 overflow-x-auto border-b border-slate-200/80 bg-white px-3 py-2 dark:border-slate-800 dark:bg-slate-900 md:hidden" aria-label="Admin sections">
          {NAV.filter((n) => isSuper || !n.superOnly).map((n) => (
            <Link key={n.href} href={n.href} className={cn('whitespace-nowrap rounded-md px-3 py-1.5 text-xs font-medium', pathname.startsWith(n.href) ? 'bg-indigo-50 text-indigo-700' : 'text-slate-600')}>
              {n.name}
            </Link>
          ))}
        </nav>
        <main className="flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8">
          <div className="mx-auto max-w-6xl space-y-6">{children}</div>
        </main>
      </div>
    </div>
  );
}
