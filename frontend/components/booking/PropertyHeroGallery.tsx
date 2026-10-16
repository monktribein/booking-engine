'use client';

import React from 'react';
import { motion } from 'framer-motion';
import { ShieldCheck, Image as ImageIcon, MapPin } from 'lucide-react';

interface PropertyHeroGalleryProps {
  propertyName: string;
  images: Array<{ url: string; caption?: string }>;
  locationText?: string;
}

const FALLBACK_HERO_IMAGES = [
  {
    url: '/images/stays/radha-ashram-facade.jpg',
    caption: 'Radha Ashram - Traditional Sandstone Facade & Temple Spire',
  },
  {
    url: '/images/stays/radha-ashram-courtyard.jpg',
    caption: 'Sacred Inner Courtyard & Colonnade',
  },
  {
    url: 'https://images.unsplash.com/photo-1662376107358-21296a9234f1?auto=format&fit=crop&w=1200&q=80',
    caption: 'Vrindavan Sacred Mandir & Spiritual Surroundings',
  },
  {
    url: '/images/stays/radha-ashram-room.jpg',
    caption: 'Clean, Traditional Ashram Guest Room',
  },
];

export function PropertyHeroGallery({
  propertyName,
  images = [],
  locationText,
}: PropertyHeroGalleryProps) {
  // Filter out invalid or dummy .example domains
  const validUserImages = (images || []).filter(
    (img) => img?.url && !img.url.includes('.example') && !img.url.includes('example.com')
  );

  // Combine with authentic Vrindavan fallback images
  const displayPhotos = [
    ...validUserImages,
    ...FALLBACK_HERO_IMAGES.slice(validUserImages.length),
  ].slice(0, 3);

  return (
    <motion.div
      initial={{ opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6, ease: 'easeOut' }}
      className="relative rounded-3xl overflow-hidden border border-stone-200/90 bg-stone-100"
    >
      <div className="grid grid-cols-1 md:grid-cols-3 gap-2 h-[290px] sm:h-[390px] lg:h-[430px]">
        {/* Main Hero Photo (Left / 2 columns on desktop) */}
        <div className="relative md:col-span-2 h-full overflow-hidden group">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={displayPhotos[0]?.url || FALLBACK_HERO_IMAGES[0].url}
            alt={displayPhotos[0]?.caption || propertyName}
            className="h-full w-full object-cover transition-transform duration-700 ease-out group-hover:scale-105"
            onError={(e) => {
              e.currentTarget.src = FALLBACK_HERO_IMAGES[0].url;
            }}
          />
          <div className="absolute inset-0 bg-gradient-to-t from-black/65 via-transparent to-black/15 pointer-events-none" />

          {/* Badges on Main Image */}
          <div className="absolute top-4 left-4 flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-white/95 backdrop-blur-md px-3 py-1 text-xs font-semibold text-slate-800 border border-white/40">
              <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" />
              Verified Ashram Stay
            </span>
            {locationText && (
              <span className="hidden sm:inline-flex items-center gap-1.5 rounded-full bg-slate-900/80 backdrop-blur-md px-3 py-1 text-xs font-medium text-white">
                <MapPin className="h-3 w-3 text-sky-400" />
                {locationText}
              </span>
            )}
          </div>

          <div className="absolute bottom-4 left-4 right-4">
            <p className="text-white text-sm sm:text-base font-semibold drop-shadow-xs">
              {displayPhotos[0]?.caption || `${propertyName} - Entrance & Courtyard`}
            </p>
          </div>
        </div>

        {/* Secondary Photos (Right side stacked) */}
        <div className="hidden md:flex flex-col gap-2 h-full">
          {displayPhotos.slice(1, 3).map((img, idx) => (
            <div key={idx} className="relative flex-1 overflow-hidden group">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={img.url}
                alt={img.caption || `${propertyName} photo ${idx + 2}`}
                className="h-full w-full object-cover transition-transform duration-700 ease-out group-hover:scale-105"
                onError={(e) => {
                  e.currentTarget.src = FALLBACK_HERO_IMAGES[idx + 1]?.url || FALLBACK_HERO_IMAGES[0].url;
                }}
              />
              <div className="absolute inset-0 bg-gradient-to-t from-black/55 via-transparent to-transparent pointer-events-none" />
              <div className="absolute bottom-3 left-3 right-3">
                <span className="text-[11px] font-medium text-white/95 line-clamp-1 drop-shadow-xs">
                  {img.caption || (idx === 0 ? 'Sacred Courtyard' : 'Vrindavan Grounds')}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Floating gallery count badge */}
      <div className="absolute bottom-3 right-3 sm:bottom-4 sm:right-4">
        <div className="inline-flex items-center gap-1.5 rounded-full bg-white/95 backdrop-blur-md px-3 py-1 text-xs font-medium text-slate-800 border border-stone-200">
          <ImageIcon className="h-3.5 w-3.5 text-slate-500" />
          <span>Vrindavan Heritage Grounds</span>
        </div>
      </div>
    </motion.div>
  );
}
