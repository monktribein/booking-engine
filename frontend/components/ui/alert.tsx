import React from 'react';
import { cn } from '@/lib/utils/cn';
import { AlertCircle, AlertTriangle, CheckCircle, Info, X } from 'lucide-react';

export interface AlertProps {
  variant?: 'info' | 'warning' | 'danger' | 'success';
  title?: string;
  message: string;
  onClose?: () => void;
  action?: {
    label: string;
    onClick: () => void;
  };
  className?: string;
}

export function Alert({
  variant = 'info',
  title,
  message,
  onClose,
  action,
  className,
}: AlertProps) {
  const configs = {
    info: {
      bg: 'bg-blue-50 dark:bg-blue-950/30 border-blue-200 dark:border-blue-900',
      text: 'text-blue-800 dark:text-blue-300',
      icon: <Info className="h-5 w-5 text-blue-600 dark:text-blue-400 shrink-0" />,
    },
    warning: {
      bg: 'bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-900',
      text: 'text-amber-800 dark:text-amber-300',
      icon: <AlertTriangle className="h-5 w-5 text-amber-600 dark:text-amber-400 shrink-0" />,
    },
    danger: {
      bg: 'bg-rose-50 dark:bg-rose-950/30 border-rose-200 dark:border-rose-900',
      text: 'text-rose-800 dark:text-rose-300',
      icon: <AlertCircle className="h-5 w-5 text-rose-600 dark:text-rose-400 shrink-0" />,
    },
    success: {
      bg: 'bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-900',
      text: 'text-emerald-800 dark:text-emerald-300',
      icon: <CheckCircle className="h-5 w-5 text-emerald-600 dark:text-emerald-400 shrink-0" />,
    },
  };

  const current = configs[variant];

  return (
    <div
      role="alert"
      className={cn(
        'relative flex items-start gap-3 rounded-xl border p-4 text-sm shadow-xs transition-all',
        current.bg,
        current.text,
        className
      )}
    >
      {current.icon}
      <div className="flex-1">
        {title && <h5 className="font-semibold tracking-tight mb-0.5">{title}</h5>}
        <p className="text-xs leading-relaxed opacity-90">{message}</p>
        {action && (
          <button
            type="button"
            onClick={action.onClick}
            className="mt-2 text-xs font-semibold underline underline-offset-2 hover:opacity-80 cursor-pointer"
          >
            {action.label}
          </button>
        )}
      </div>

      {onClose && (
        <button
          type="button"
          aria-label="Dismiss"
          onClick={onClose}
          className="rounded p-1 hover:bg-black/5 dark:hover:bg-white/5 opacity-70 hover:opacity-100"
        >
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}

export function ErrorBanner({ code, message, onRetry }: { code?: string; message?: string; onRetry?: () => void }) {
  let displayMessage = message;

  switch (code) {
    case 'ROOM_NOT_AVAILABLE':
      displayMessage = 'The selected room is no longer available. Please choose another room or date.';
      break;
    case 'PAYMENT_FAILED':
      displayMessage = 'The payment could not be processed. Please verify your card or UPI details and try again.';
      break;
    case 'SESSION_EXPIRED':
      displayMessage = 'Your session has expired. Please sign in again to continue.';
      break;
    case 'CHANNEL_DISCONNECTED':
      displayMessage = 'This channel connection is currently disconnected. Please re-authenticate the channel.';
      break;
    case 'SYNC_FAILED':
      displayMessage = 'Last channel synchronization encountered an error. Click retry to run manual synchronization.';
      break;
    case 'MAPPING_CONFLICT':
      displayMessage = 'Conflict in channel mapping: this listing or rate plan is already mapped to another entity.';
      break;
    case 'INVALID_DATES':
      displayMessage = 'Invalid dates selected. Check-out date must be after check-in date.';
      break;
    case 'NETWORK_ERROR':
      displayMessage = 'Unable to reach the server. Please check your network connection.';
      break;
    default:
      displayMessage = message || 'An error occurred while performing this operation.';
  }

  return (
    <Alert
      variant="danger"
      title={code ? `Error: ${code}` : 'Operation Failed'}
      message={displayMessage}
      action={onRetry ? { label: 'Retry Operation', onClick: onRetry } : undefined}
    />
  );
}
