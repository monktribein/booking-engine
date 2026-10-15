import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';
import { QueryProvider } from '@/lib/query-provider';
import { AuthProvider } from '@/lib/auth/auth-context';
import { PropertyProvider } from '@/lib/auth/property-context';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter' });

export const metadata: Metadata = {
  title: 'Tirvona - PMS, Booking Engine & Channel Manager',
  description: 'Enterprise hospitality PMS and channel manager connected to official OTA partner APIs.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${inter.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col font-sans">
        <QueryProvider>
          <AuthProvider>
            <PropertyProvider>{children}</PropertyProvider>
          </AuthProvider>
        </QueryProvider>
      </body>
    </html>
  );
}
