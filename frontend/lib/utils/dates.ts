import { addDays, differenceInCalendarDays, format, parseISO } from 'date-fns';

export function formatDate(date: string | Date | undefined, formatStr: string = 'dd MMM yyyy'): string {
  if (!date) return '-';
  try {
    const d = typeof date === 'string' ? parseISO(date) : date;
    return format(d, formatStr);
  } catch {
    return String(date);
  }
}

export function formatDateShort(date: string | Date | undefined): string {
  return formatDate(date, 'd MMM');
}

export function formatDateTime(date: string | Date | undefined): string {
  return formatDate(date, 'd MMM yyyy, h:mm a');
}

export function formatTime(date: string | Date | undefined): string {
  return formatDate(date, 'h:mm a');
}

export function formatISODate(date: Date): string {
  return format(date, 'yyyy-MM-dd');
}

export function calculateNights(checkIn: string | Date, checkOut: string | Date): number {
  try {
    const inDate = typeof checkIn === 'string' ? parseISO(checkIn) : checkIn;
    const outDate = typeof checkOut === 'string' ? parseISO(checkOut) : checkOut;
    const diff = differenceInCalendarDays(outDate, inDate);
    return diff > 0 ? diff : 1;
  } catch {
    return 1;
  }
}

export function getDatesBetween(startDate: Date, endDate: Date): Date[] {
  const dates: Date[] = [];
  let curr = new Date(startDate);
  while (curr <= endDate) {
    dates.push(new Date(curr));
    curr = addDays(curr, 1);
  }
  return dates;
}

/**
 * Today's calendar date (YYYY-MM-DD) in an IANA time zone. Hotel dates are the property's local calendar days, so "today" must
 * come from the property's zone, not the browser's. An unknown zone falls back to the browser's own day.
 */
export function todayInTimeZone(timeZone: string | undefined, now: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  } catch {
    return format(now, 'yyyy-MM-dd');
  }
}
