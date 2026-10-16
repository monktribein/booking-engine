'use client';

import React from 'react';
import { motion, Variants } from 'framer-motion';
import { Sparkles, Clock, MapPin, Check, Compass, Navigation, ShieldCheck } from 'lucide-react';

interface PropertyInfoCardsProps {
  propertyName: string;
  description: string;
  amenities: string[];
  checkInTime: string;
  checkOutTime: string;
  address: string;
  city: string;
  state: string;
  country: string;
}

const containerVariants: Variants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: 0.16,
      delayChildren: 0.1,
    },
  },
};

const cardVariants: Variants = {
  hidden: { opacity: 0, y: 36, scale: 0.96 },
  visible: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: {
      type: 'spring',
      stiffness: 110,
      damping: 14,
      mass: 0.8,
    },
  },
};

export function PropertyInfoCards({
  propertyName,
  description,
  amenities,
  checkInTime,
  checkOutTime,
  address,
  city,
  state,
  country,
}: PropertyInfoCardsProps) {
  return (
    <div className="space-y-6">
      {/* Property Overview Banner - Reveals on scroll */}
      <motion.div
        initial={{ opacity: 0, y: 30 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, amount: 0.25 }}
        transition={{ duration: 0.5, ease: 'easeOut' }}
        className="rounded-2xl border border-stone-200/90 bg-white dark:bg-slate-900 p-5 sm:p-6"
      >
        <div className="flex items-center gap-2 mb-2">
          <span className="text-xs font-bold uppercase tracking-wider text-slate-400">About This Stay</span>
          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 text-emerald-700 px-2 py-0.5 text-[10px] font-semibold border border-emerald-200/60">
            <ShieldCheck className="h-3 w-3" /> Braj Dham Ashram
          </span>
        </div>
        <p className="text-sm sm:text-base text-slate-700 dark:text-slate-300 leading-relaxed font-normal">
          {description}
        </p>
      </motion.div>

      {/* Symmetrical 3-Column Information Cards with Staggered Scroll Animation & Interactive Hover */}
      <motion.div
        variants={containerVariants}
        initial="hidden"
        whileInView="visible"
        viewport={{ once: true, amount: 0.15 }}
        className="grid grid-cols-1 md:grid-cols-3 gap-6 items-stretch"
      >
        {/* Card 1: Property Amenities */}
        <motion.div
          variants={cardVariants}
          whileHover={{
            y: -7,
            scale: 1.015,
            transition: { duration: 0.25, ease: 'easeOut' },
          }}
          className="rounded-2xl border border-stone-200/90 hover:border-[#a8c6e5] dark:border-slate-800 p-5 bg-white dark:bg-slate-900 flex flex-col justify-between space-y-4 cursor-default transition-colors group"
        >
          <div className="space-y-3">
            <div className="flex items-center gap-2.5">
              <motion.div
                whileHover={{ rotate: [0, -10, 10, 0], scale: 1.15 }}
                transition={{ duration: 0.4 }}
                className="p-2.5 rounded-xl bg-[#c1d8f0]/50 text-slate-900 border border-[#a8c6e5]/60 transition-transform"
              >
                <Sparkles className="h-4 w-4 text-slate-800" />
              </motion.div>
              <div>
                <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100 group-hover:text-slate-950 transition-colors">
                  Property Amenities
                </h3>
                <p className="text-[11px] text-slate-500">Key comforts & sacred facilities</p>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-1 gap-2 pt-1">
              {amenities.map((amenity, idx) => (
                <motion.div
                  key={idx}
                  whileHover={{ x: 3 }}
                  className="flex items-center gap-2 text-xs font-medium text-slate-700 dark:text-slate-300 py-0.5"
                >
                  <div className="h-4 w-4 rounded-full bg-emerald-50 border border-emerald-200/70 flex items-center justify-center shrink-0">
                    <Check className="h-3 w-3 text-emerald-600" />
                  </div>
                  <span className="capitalize">{amenity.replace(/-/g, ' ')}</span>
                </motion.div>
              ))}
            </div>
          </div>
          <div className="pt-2.5 border-t border-stone-100 dark:border-slate-800 text-[11px] text-slate-400 font-medium">
            ✓ Pure vegetarian ashram kitchen & wifi
          </div>
        </motion.div>

        {/* Card 2: Rules & Timings */}
        <motion.div
          variants={cardVariants}
          whileHover={{
            y: -7,
            scale: 1.015,
            transition: { duration: 0.25, ease: 'easeOut' },
          }}
          className="rounded-2xl border border-stone-200/90 hover:border-[#a8c6e5] dark:border-slate-800 p-5 bg-white dark:bg-slate-900 flex flex-col justify-between space-y-4 cursor-default transition-colors group"
        >
          <div className="space-y-3">
            <div className="flex items-center gap-2.5">
              <motion.div
                whileHover={{ rotate: [0, -10, 10, 0], scale: 1.15 }}
                transition={{ duration: 0.4 }}
                className="p-2.5 rounded-xl bg-[#c1d8f0]/50 text-slate-900 border border-[#a8c6e5]/60 transition-transform"
              >
                <Clock className="h-4 w-4 text-slate-800" />
              </motion.div>
              <div>
                <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100 group-hover:text-slate-950 transition-colors">
                  Rules & Timings
                </h3>
                <p className="text-[11px] text-slate-500">Check-in, checkout & ashram etiquette</p>
              </div>
            </div>

            <div className="space-y-2.5 pt-1 text-xs">
              <motion.div
                whileHover={{ scale: 1.02 }}
                className="p-2.5 rounded-xl bg-stone-50 dark:bg-slate-800 border border-stone-200/60 dark:border-slate-700 flex items-center justify-between transition-colors"
              >
                <span className="text-slate-600 dark:text-slate-400 font-medium">Check-in Time</span>
                <span className="font-bold text-slate-900 dark:text-slate-100">{checkInTime}</span>
              </motion.div>
              <motion.div
                whileHover={{ scale: 1.02 }}
                className="p-2.5 rounded-xl bg-stone-50 dark:bg-slate-800 border border-stone-200/60 dark:border-slate-700 flex items-center justify-between transition-colors"
              >
                <span className="text-slate-600 dark:text-slate-400 font-medium">Check-out Time</span>
                <span className="font-bold text-slate-900 dark:text-slate-100">{checkOutTime}</span>
              </motion.div>
              <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed pt-1">
                Flexible cancellation available. Sacred morning & evening aarti silence maintained.
              </p>
            </div>
          </div>
          <div className="pt-2.5 border-t border-stone-100 dark:border-slate-800 text-[11px] text-slate-400 font-medium">
            Peaceful environment & Parikrama hospitality
          </div>
        </motion.div>

        {/* Card 3: Contact & Location */}
        <motion.div
          variants={cardVariants}
          whileHover={{
            y: -7,
            scale: 1.015,
            transition: { duration: 0.25, ease: 'easeOut' },
          }}
          className="rounded-2xl border border-stone-200/90 hover:border-[#a8c6e5] dark:border-slate-800 p-5 bg-white dark:bg-slate-900 flex flex-col justify-between space-y-4 cursor-default transition-colors group"
        >
          <div className="space-y-3">
            <div className="flex items-center gap-2.5">
              <motion.div
                whileHover={{ rotate: [0, -10, 10, 0], scale: 1.15 }}
                transition={{ duration: 0.4 }}
                className="p-2.5 rounded-xl bg-[#c1d8f0]/50 text-slate-900 border border-[#a8c6e5]/60 transition-transform"
              >
                <MapPin className="h-4 w-4 text-slate-800" />
              </motion.div>
              <div>
                <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100 group-hover:text-slate-950 transition-colors">
                  Contact & Location
                </h3>
                <p className="text-[11px] text-slate-500">{city}, {state}</p>
              </div>
            </div>

            <div className="space-y-2.5 pt-1 text-xs">
              <div className="p-2.5 rounded-xl bg-stone-50 dark:bg-slate-800 border border-stone-200/60 dark:border-slate-700 space-y-1">
                <p className="font-semibold text-slate-900 dark:text-slate-100 leading-snug">{address}</p>
                <p className="text-[11px] text-slate-500 dark:text-slate-400">
                  {city}, {state}, {country}
                </p>
              </div>

              <div className="flex items-center gap-1.5 text-[11px] text-slate-600 dark:text-slate-400">
                <Compass className="h-3.5 w-3.5 text-sky-600 shrink-0" />
                <span>Near Raman Reti & Bankey Bihari Parikrama Marg</span>
              </div>
            </div>
          </div>

          <div>
            <motion.a
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
              href={`https://maps.google.com/?q=${encodeURIComponent(`${propertyName} ${address} ${city}`)}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center justify-center w-full rounded-xl bg-[#c1d8f0] hover:bg-[#acc8e6] text-slate-900 font-semibold border border-[#a8c6e5] py-2 text-xs transition-colors cursor-pointer"
            >
              <Navigation className="h-3.5 w-3.5 mr-1.5" /> Open in Google Maps
            </motion.a>
          </div>
        </motion.div>
      </motion.div>
    </div>
  );
}
