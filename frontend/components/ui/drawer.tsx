'use client';

import React, { useId, useRef } from 'react';
import { cn } from '@/lib/utils/cn';
import { useModalFocus } from '@/lib/hooks/use-modal-focus';
import { X } from 'lucide-react';

export interface DrawerProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  description?: string;
  children: React.ReactNode;
  width?: 'sm' | 'md' | 'lg' | 'xl';
}

export function Drawer({
  isOpen,
  onClose,
  title,
  description,
  children,
  width = 'lg',
}: DrawerProps) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useModalFocus(isOpen, onClose, ref);

  if (!isOpen) return null;

  const widths = {
    sm: 'max-w-md',
    md: 'max-w-xl',
    lg: 'max-w-2xl',
    xl: 'max-w-3xl',
  };

  return (
    <div className="fixed inset-0 z-50 overflow-hidden animate-in fade-in duration-200">
      <div
        className="fixed inset-0 bg-slate-900/40 backdrop-blur-xs transition-opacity"
        onClick={onClose}
        aria-hidden="true"
      />

      <div className="fixed inset-y-0 right-0 flex max-w-full pl-10">
        <div
          ref={ref}
          role="dialog"
          aria-modal="true"
          aria-labelledby={title ? titleId : undefined}
          tabIndex={-1}
          className={cn(
            'w-screen bg-white shadow-2xl outline-none transition-transform border-l border-stone-200 flex flex-col',
            widths[width]
          )}
        >
          {/* Header */}
          <div className="px-6 py-5 border-b border-stone-200 flex items-center justify-between">
            <div>
              {title && <h2 id={titleId} className="text-lg font-bold text-slate-900">{title}</h2>}
              {description && <p className="text-xs text-slate-500 mt-0.5">{description}</p>}
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl p-1.5 text-slate-500 hover:bg-stone-100 hover:text-slate-700 focus-visible:outline-2 focus-visible:outline-indigo-600 transition-colors cursor-pointer"
            >
              <X className="h-5 w-5" aria-hidden="true" />
              <span className="sr-only">Close</span>
            </button>
          </div>

          {/* Body Content */}
          <div className="flex-1 overflow-y-auto p-6">{children}</div>
        </div>
      </div>
    </div>
  );
}
