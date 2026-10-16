'use client';

import React, { useState } from 'react';
import { useProperty } from '@/lib/auth/property-context';
import { Building2, ChevronDown, Check } from 'lucide-react';
import { cn } from '@/lib/utils/cn';

export function PropertySelector() {
  const { activeProperty, properties, setActiveProperty } = useProperty();
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div className="relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-2.5 rounded-xl border border-stone-300/80 bg-white px-3 py-1.5 text-left text-xs font-medium text-slate-800 hover:bg-stone-50 transition-all cursor-pointer"
      >
        <div className="flex h-6 w-6 items-center justify-center rounded-lg bg-[#c1d8f0]/40 text-slate-800 border border-[#a8c6e5]/60">
          <Building2 className="h-3.5 w-3.5" />
        </div>
        <div className="flex flex-col">
          <span className="font-bold text-slate-900 truncate max-w-[130px]">
            {activeProperty?.name ?? 'No property'}
          </span>
          <span className="text-[10px] text-slate-500">{activeProperty ? `${activeProperty.city}, ${activeProperty.state}` : ''}</span>
        </div>
        <ChevronDown className="h-3.5 w-3.5 text-slate-400 ml-1" />
      </button>

      {isOpen && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setIsOpen(false)} />
          <div className="absolute left-0 mt-2 z-50 w-64 rounded-2xl border border-stone-200 bg-white p-2 animate-in fade-in duration-150">
            <div className="px-2 py-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-400">
              Active Properties
            </div>
            {properties.map((p) => {
              const isSelected = p._id === activeProperty?._id;
              return (
                <button
                  key={p._id}
                  onClick={() => {
                    setActiveProperty(p);
                    setIsOpen(false);
                  }}
                  className={cn(
                    'flex w-full items-center justify-between rounded-xl px-2.5 py-2 text-xs transition-colors cursor-pointer text-left',
                    isSelected
                      ? 'bg-[#c1d8f0]/30 font-bold text-slate-900 border border-[#a8c6e5]/50'
                      : 'text-slate-700 hover:bg-stone-100'
                  )}
                >
                  <div className="flex flex-col">
                    <span className="font-semibold text-slate-900">{p.name}</span>
                    <span className="text-[10px] text-slate-500">{p.city}, {p.country}</span>
                  </div>
                  {isSelected && <Check className="h-4 w-4 text-slate-900" />}
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
