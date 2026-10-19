import React from 'react';
import Link from 'next/link';

interface BrandLogoProps {
  href?: string;
  size?: 'sm' | 'md' | 'lg';
  subtitle?: string;
  className?: string;
}

export function BrandLogo({ href = '/', size = 'md', subtitle, className = '' }: BrandLogoProps) {
  const iconSizeClasses = {
    sm: 'h-8 w-8 text-sm',
    md: 'h-9 w-9 text-base',
    lg: 'h-10 w-10 text-lg',
  }[size];

  const textSizeClasses = {
    sm: 'text-base',
    md: 'text-xl',
    lg: 'text-2xl',
  }[size];

  const content = (
    <div className={`flex items-center gap-2.5 group shrink-0 ${className}`}>
      <div
        className={`flex ${iconSizeClasses} items-center justify-center rounded-xl bg-[#c1d8f0] text-slate-900 border border-[#a8c6e5] shadow-2xs transition-transform group-hover:scale-105 font-bold select-none`}
      >
        <span>T</span>
      </div>
      <div className="flex flex-col">
        <span className={`${textSizeClasses} font-bold tracking-tight text-slate-900 dark:text-slate-100`}>
          Tirvona
        </span>
        {subtitle && (
          <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
            {subtitle}
          </span>
        )}
      </div>
    </div>
  );

  if (href) {
    return <Link href={href}>{content}</Link>;
  }
  return content;
}
