import React from 'react';
import { DashboardLayout } from '@/components/dashboard/DashboardLayout';
import { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Tirvona Hospitality PMS & Channel Manager',
  description: 'Production hotel PMS, inventory distribution, calendar, and channel manager.',
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <DashboardLayout>{children}</DashboardLayout>;
}
