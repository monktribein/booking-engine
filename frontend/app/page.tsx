'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { motion, type Variants } from 'framer-motion';
import { Button } from '@/components/ui/button';
import {
  Calendar,
  Building2,
  CheckCircle2,
  ArrowRight,
  ExternalLink,
  RefreshCw,
  LogOut,
  ChevronDown,
} from 'lucide-react';
import { useAuth } from '@/lib/auth/auth-context';

import { BrandLogo } from '@/components/ui/brand-logo';

export default function RootHomePage() {
  const { user, logout } = useAuth();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);
  const containerVariants: Variants = {
    hidden: { opacity: 0 },
    visible: {
      opacity: 1,
      transition: {
        staggerChildren: 0.12,
        delayChildren: 0.1,
      },
    },
  };

  const itemVariants: Variants = {
    hidden: { opacity: 0, y: 20 },
    visible: {
      opacity: 1,
      y: 0,
      transition: { duration: 0.6, ease: 'easeOut' },
    },
  };

  const sectionVariants: Variants = {
    hidden: { opacity: 0 },
    visible: {
      opacity: 1,
      transition: {
        staggerChildren: 0.18,
        delayChildren: 0.05,
      },
    },
  };

  const cardLeftVariants: Variants = {
    hidden: { opacity: 0, y: 60, x: -30, rotate: -2.5, scale: 0.93 },
    visible: {
      opacity: 1,
      y: 0,
      x: 0,
      rotate: 0,
      scale: 1,
      transition: {
        type: 'spring',
        damping: 18,
        stiffness: 85,
        mass: 0.8,
      },
    },
  };

  const cardCenterVariants: Variants = {
    hidden: { opacity: 0, y: 75, scale: 0.9 },
    visible: {
      opacity: 1,
      y: 0,
      scale: 1,
      transition: {
        type: 'spring',
        damping: 16,
        stiffness: 90,
        mass: 0.8,
      },
    },
  };

  const cardRightVariants: Variants = {
    hidden: { opacity: 0, y: 60, x: 30, rotate: 2.5, scale: 0.93 },
    visible: {
      opacity: 1,
      y: 0,
      x: 0,
      rotate: 0,
      scale: 1,
      transition: {
        type: 'spring',
        damping: 18,
        stiffness: 85,
        mass: 0.8,
      },
    },
  };

  return (
    <div className="min-h-screen bg-[#FAF9F5] text-slate-900 font-sans selection:bg-[#c1d8f0] selection:text-slate-900 antialiased">
      {/* Top Navigation - Aligned with max-w-6xl container */}
      <motion.header
        initial={{ y: -20, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 0.5 }}
        className="sticky top-0 z-50 border-b border-stone-200/80 bg-[#FAF9F5]/90 backdrop-blur-md"
      >
        <div className="mx-auto max-w-7xl px-6 sm:px-10 h-18 grid grid-cols-[auto_1fr_auto] items-center gap-6">
          {/* Left: Brand Logo */}
          <BrandLogo />

          {/* Center: Navigation Links in middle - cleanly spaced */}
          <nav className="hidden md:flex items-center justify-center gap-6 lg:gap-8 text-sm font-medium text-slate-600">
            <Link
              href="/dashboard/calendar"
              className="hover:text-slate-900 transition-colors whitespace-nowrap"
            >
              Tape Chart
            </Link>
            <Link
              href="/dashboard/channels"
              className="hover:text-slate-900 transition-colors whitespace-nowrap"
            >
              Channel Sync
            </Link>
            <Link
              href="/dashboard/guests"
              className="hover:text-slate-900 transition-colors whitespace-nowrap"
            >
              Guest Directory
            </Link>
          </nav>

          {/* Right: User Avatar Logo & Dashboard access (if logged in) or Sign In Button */}
          <div className="flex items-center justify-end shrink-0 gap-2.5">
            {mounted && user ? (
              <div className="flex items-center gap-2">
                <Link
                  href="/dashboard"
                  title="Open PMS Dashboard"
                  className="flex items-center gap-2.5 rounded-full bg-[#c1d8f0]/40 hover:bg-[#c1d8f0]/70 border border-[#a8c6e5] p-1.5 pr-4 transition-all group cursor-pointer shadow-2xs hover:scale-[1.02]"
                >
                  {/* User Profile Logo / Avatar with Initials & active green indicator */}
                  <div className="relative flex h-8 w-8 items-center justify-center rounded-full bg-[#c1d8f0] text-slate-900 font-bold text-xs border border-[#a8c6e5] shadow-2xs group-hover:scale-105 transition-transform">
                    <span>{user.name ? user.name[0].toUpperCase() : 'U'}</span>
                    <span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-emerald-500 border-2 border-[#FAF9F5]" title="Online" />
                  </div>

                  <div className="flex flex-col text-left">
                    <span className="text-xs font-bold text-slate-900 leading-tight">
                      {user.name || 'Owner'}
                    </span>
                    <span className="text-[10px] text-slate-600 font-medium leading-tight flex items-center gap-1 group-hover:text-slate-950">
                      <span>Dashboard</span>
                      <ArrowRight className="h-3 w-3 transition-transform group-hover:translate-x-0.5" />
                    </span>
                  </div>
                </Link>

                <button
                  type="button"
                  onClick={() => logout()}
                  title="Sign Out"
                  className="flex h-8 w-8 items-center justify-center rounded-full border border-stone-200 bg-white hover:bg-stone-100 text-slate-400 hover:text-slate-800 transition-colors cursor-pointer"
                >
                  <LogOut className="h-3.5 w-3.5" />
                  <span className="sr-only">Sign Out</span>
                </button>
              </div>
            ) : (
              <Link href="/login">
                <button
                  type="button"
                  className="inline-flex items-center justify-center rounded-full bg-[#c1d8f0] hover:bg-[#acc8e6] text-slate-900 font-semibold border border-[#a8c6e5] px-5 py-2 text-sm transition-transform hover:-translate-y-0.5 cursor-pointer whitespace-nowrap"
                >
                  Sign In
                </button>
              </Link>
            )}
          </div>
        </div>
      </motion.header>

      {/* Main Container */}
      <main className="mx-auto max-w-7xl px-6 sm:px-10">
        {/* Full-Screen Hero Fold - Ensures below-the-fold content is not visible until scroll */}
        <section className="min-h-[calc(100vh-4.5rem)] flex flex-col justify-between items-center py-8 sm:py-12">
          {/* Top spacer for optical vertical centering */}
          <div className="w-full h-2 sm:h-6" aria-hidden="true" />

          {/* Centered Hero Content */}
          <motion.div
            variants={containerVariants}
            initial="hidden"
            animate="visible"
            className="text-center space-y-6 max-w-5xl mx-auto my-auto"
          >
            {/* Main Headline in Inter with ample width */}
            <motion.h1
              variants={itemVariants}
              className="text-4xl sm:text-5xl md:text-[54px] lg:text-[60px] font-bold tracking-tight text-slate-900 leading-[1.18]"
            >
              <span className="block whitespace-normal sm:whitespace-nowrap">Intelligent Hotel Management</span>
              <span className="block font-normal text-slate-700 mt-1 sm:mt-2">& Direct Bookings</span>
            </motion.h1>

            {/* Subtitle in Inter */}
            <motion.p
              variants={itemVariants}
              className="text-base sm:text-lg text-slate-600 max-w-2xl mx-auto font-normal leading-relaxed"
            >
              Unified inventory and channel sync without double bookings. Run your tape chart, OTA distribution, and guest checkout from one cohesive operating system.
            </motion.p>

            {/* Hero Action Buttons - Compact size with transparent secondary button */}
            <motion.div
              variants={itemVariants}
              className="flex flex-col sm:flex-row items-center justify-center gap-3 pt-2"
            >
              <Link href="/dashboard">
                <button
                  type="button"
                  className="inline-flex items-center justify-center rounded-full bg-[#c1d8f0] hover:bg-[#acc8e6] text-slate-900 font-semibold border border-[#a8c6e5] px-5 py-2.5 text-sm shadow-2xs transition-transform hover:-translate-y-0.5 cursor-pointer whitespace-nowrap"
                >
                  Open PMS Dashboard <ArrowRight className="h-4 w-4 ml-1.5" />
                </button>
              </Link>
              <Link href="/stays">
                <button
                  type="button"
                  className="inline-flex items-center justify-center rounded-full bg-transparent hover:bg-slate-100 text-slate-800 font-medium border border-slate-300 px-5 py-2.5 text-sm transition-transform hover:-translate-y-0.5 cursor-pointer whitespace-nowrap"
                >
                  Explore Guest Direct Engine <ExternalLink className="h-3.5 w-3.5 ml-1.5 opacity-60" />
                </button>
              </Link>
            </motion.div>
          </motion.div>

          {/* Interactive Scroll-to-explore indicator at bottom of Hero fold */}
          <motion.div
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.8, duration: 0.6 }}
            className="flex flex-col items-center gap-1.5 pt-6 pb-2 text-slate-400 hover:text-slate-800 transition-colors cursor-pointer select-none"
            onClick={() => {
              document.getElementById('pillars-section')?.scrollIntoView({ behavior: 'smooth' });
            }}
          >
            <span className="text-[11px] font-semibold uppercase tracking-widest text-slate-400">
              Scroll to explore
            </span>
            <motion.div
              animate={{ y: [0, 5, 0] }}
              transition={{ repeat: Infinity, duration: 1.8, ease: "easeInOut" }}
            >
              <ChevronDown className="h-4 w-4 text-slate-500" />
            </motion.div>
          </motion.div>
        </section>

        {/* 3 Core Pillars Bento Grid - Only loads & reveals when scrolled into view */}
        <section id="pillars-section" className="pt-20 pb-28 w-full scroll-mt-16">
          <motion.div
            initial={{ opacity: 0, y: 35 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, amount: 0.35, margin: "-60px" }}
            transition={{ duration: 0.65, ease: 'easeOut' }}
            className="text-center max-w-xl mx-auto mb-14 space-y-2"
          >
            <h3 className="text-2xl sm:text-3xl font-bold tracking-tight text-slate-900">
              Three Pillars, One Unified Inventory
            </h3>
            <p className="text-sm text-slate-600">
              Everything property managers need to run operations and direct revenue.
            </p>
          </motion.div>

          <motion.div
            variants={sectionVariants}
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true, amount: 0.2, margin: "-70px" }}
            className="grid grid-cols-1 md:grid-cols-3 gap-6 w-full"
          >
            {/* Pillar 1: PMS Tape Chart */}
            <motion.div
              id="tape-chart"
              variants={cardLeftVariants}
              whileHover={{ y: -8, scale: 1.015, transition: { duration: 0.25, ease: 'easeOut' } }}
              className="rounded-3xl border border-stone-200/90 bg-white p-7 space-y-5 shadow-xs hover:border-[#a8c6e5] transition-colors group flex flex-col justify-between"
            >
              <div className="space-y-4">
                <motion.div
                  whileHover={{ rotate: 10, scale: 1.12 }}
                  transition={{ type: 'spring', stiffness: 300, damping: 15 }}
                  className="flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-100 text-slate-900 border border-slate-200/80 shadow-2xs"
                >
                  <Calendar className="h-6 w-6" />
                </motion.div>
                <div>
                  <h3 className="text-xl font-bold text-slate-900 group-hover:text-slate-950 transition-colors">
                    PMS Tape Chart
                  </h3>
                  <p className="text-xs sm:text-sm text-slate-600 mt-2 leading-relaxed">
                    Interactive multi-property calendar tape chart with room statuses, housekeeping states, stay notes, and atomic inventory lock with zero double-selling.
                  </p>
                </div>
                <div className="space-y-2.5 pt-1 text-xs text-slate-600">
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0" />
                    <span>Interactive day, week, and month tape chart</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0" />
                    <span>Atomic inventory lock with zero double-selling</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0" />
                    <span>Housekeeping turnover and room inspection tracking</span>
                  </div>
                </div>
              </div>

              <div className="pt-4 border-t border-stone-100">
                <Link href="/dashboard/calendar" className="block">
                  <Button className="w-full bg-[#c1d8f0] hover:bg-[#acc8e6] text-slate-900 font-semibold border border-[#a8c6e5] rounded-xl text-xs py-2.5 shadow-xs cursor-pointer transition-transform hover:-translate-y-0.5">
                    Open Tape Chart Calendar →
                  </Button>
                </Link>
              </div>
            </motion.div>

            {/* Pillar 2: Channel Manager OTA Sync */}
            <motion.div
              id="channel-sync"
              variants={cardCenterVariants}
              whileHover={{ y: -8, scale: 1.015, transition: { duration: 0.25, ease: 'easeOut' } }}
              className="rounded-3xl border border-stone-200/90 bg-white p-7 space-y-5 shadow-xs hover:border-[#a8c6e5] transition-colors group flex flex-col justify-between"
            >
              <div className="space-y-4">
                <motion.div
                  whileHover={{ rotate: 180, scale: 1.12 }}
                  transition={{ type: 'spring', stiffness: 220, damping: 15 }}
                  className="flex h-12 w-12 items-center justify-center rounded-2xl bg-amber-50 text-amber-900 border border-amber-200/80 shadow-2xs"
                >
                  <RefreshCw className="h-6 w-6" />
                </motion.div>
                <div>
                  <h3 className="text-xl font-bold text-slate-900 group-hover:text-slate-950 transition-colors">
                    Channel Manager OTA Sync
                  </h3>
                  <p className="text-xs sm:text-sm text-slate-600 mt-2 leading-relaxed">
                    Two-way synchronization across Booking.com, Airbnb, and Expedia. Push real-time rates, room closures, and stay restrictions seamlessly.
                  </p>
                </div>
                <div className="space-y-2.5 pt-1 text-xs text-slate-600">
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0" />
                    <span>2-way partner sync with instant conflict prevention</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0" />
                    <span>Automated room rate plan and restriction pushes</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0" />
                    <span>Real-time OTA channel mapping engine</span>
                  </div>
                </div>
              </div>

              <div className="pt-4 border-t border-stone-100">
                <Link href="/dashboard/channels" className="block">
                  <Button className="w-full bg-[#c1d8f0] hover:bg-[#acc8e6] text-slate-900 font-semibold border border-[#a8c6e5] rounded-xl text-xs py-2.5 shadow-xs cursor-pointer transition-transform hover:-translate-y-0.5">
                    Manage OTA Connections →
                  </Button>
                </Link>
              </div>
            </motion.div>

            {/* Pillar 3: Direct Guest Booking Engine */}
            <motion.div
              id="direct-engine"
              variants={cardRightVariants}
              whileHover={{ y: -8, scale: 1.015, transition: { duration: 0.25, ease: 'easeOut' } }}
              className="rounded-3xl border border-stone-200/90 bg-white p-7 space-y-5 shadow-xs hover:border-[#a8c6e5] transition-colors group flex flex-col justify-between"
            >
              <div className="space-y-4">
                <motion.div
                  whileHover={{ rotate: -10, scale: 1.12 }}
                  transition={{ type: 'spring', stiffness: 300, damping: 15 }}
                  className="flex h-12 w-12 items-center justify-center rounded-2xl bg-emerald-50 text-emerald-900 border border-emerald-200/80 shadow-2xs"
                >
                  <Building2 className="h-6 w-6" />
                </motion.div>
                <div>
                  <h3 className="text-xl font-bold text-slate-900 group-hover:text-slate-950 transition-colors">
                    Direct Booking Engine
                  </h3>
                  <p className="text-xs sm:text-sm text-slate-600 mt-2 leading-relaxed">
                    Commission-free direct booking engine for guests. Fast server-rendered pages, Open Graph, Schema.org rich snippets, and instant voucher generation.
                  </p>
                </div>
                <div className="space-y-2.5 pt-1 text-xs text-slate-600">
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0" />
                    <span>Server-rendered SEO with Schema.org hotel structured data</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0" />
                    <span>Real-time availability, promo codes & dynamic discounts</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0" />
                    <span>Instant booking vouchers & guest self-service portal</span>
                  </div>
                </div>
              </div>

              <div className="pt-4 border-t border-stone-100">
                <Link href="/stays" className="block">
                  <Button className="w-full bg-[#c1d8f0] hover:bg-[#acc8e6] text-slate-900 font-semibold border border-[#a8c6e5] rounded-xl text-xs py-2.5 shadow-xs cursor-pointer transition-transform hover:-translate-y-0.5">
                    Launch Direct Booking Engine ↗
                  </Button>
                </Link>
              </div>
            </motion.div>
          </motion.div>
        </section>
      </main>

      {/* Elegant Minimal Footer - Smooth scroll reveal */}
      <motion.footer
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, amount: 0.2 }}
        transition={{ duration: 0.55 }}
        className="border-t border-stone-200/80 bg-white py-10 text-slate-500 text-xs"
      >
        <div className="mx-auto max-w-7xl px-6 sm:px-10 flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <span className="font-bold text-slate-900 text-base">Tirvona</span>
            <span className="text-stone-300">•</span>
            <span>The Modern Hospitality Operating System</span>
          </div>

          <div className="flex flex-wrap items-center justify-center gap-4 sm:gap-6 text-slate-600 font-medium">
            <Link href="/dashboard/calendar" className="hover:text-slate-900 transition">PMS Tape Chart</Link>
            <Link href="/dashboard/channels" className="hover:text-slate-900 transition">Channel Sync</Link>
            <Link href="/stays" className="hover:text-slate-900 transition">Direct Booking Engine</Link>
            <Link href="/dashboard/guests" className="hover:text-slate-900 transition">Guest Directory</Link>
            {mounted && user ? (
              <Link href="/dashboard" className="hover:text-slate-900 transition">Dashboard</Link>
            ) : (
              <Link href="/login" className="hover:text-slate-900 transition">Sign In</Link>
            )}
          </div>

          <div className="text-slate-400">
            © {new Date().getFullYear()} Tirvona Inc. All rights reserved.
          </div>
        </div>
      </motion.footer>
    </div>
  );
}
