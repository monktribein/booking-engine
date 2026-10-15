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
