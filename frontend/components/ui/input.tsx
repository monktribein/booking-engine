import React from 'react';
import { cn } from '@/lib/utils/cn';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  helperText?: string;
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type = 'text', label, error, helperText, id, ...props }, ref) => {
    const inputId = id || (label ? label.toLowerCase().replace(/\s+/g, '-') : undefined);

    return (
      <div className="w-full space-y-1.5">
        {label && (
          <label htmlFor={inputId} className="block text-xs font-semibold text-slate-700">
            {label}
          </label>
        )}
        <input
          id={inputId}
          type={type}
          ref={ref}
          style={{ colorScheme: 'light', backgroundColor: '#ffffff', color: '#0f172a', ...props.style }}
          className={cn(
            'flex h-10 w-full rounded-xl border border-stone-300 !bg-white px-3.5 py-2 text-sm !text-slate-900 shadow-2xs transition-colors placeholder:text-slate-400 focus-visible:border-slate-800 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-slate-800 focus-visible:ring-2 focus-visible:ring-slate-800/10 disabled:cursor-not-allowed disabled:opacity-50',
            error && 'border-rose-500 focus-visible:border-rose-500 focus-visible:ring-rose-500/20',
            className
          )}
          {...props}
        />
        {error && <p className="text-xs font-medium text-rose-600">{error}</p>}
        {helperText && !error && <p className="text-xs text-slate-500">{helperText}</p>}
      </div>
    );
  }
);
Input.displayName = 'Input';
