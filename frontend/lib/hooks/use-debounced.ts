'use client';

import { useEffect, useState } from 'react';

/** Returns `value` after it has stopped changing for `delay` ms (keeps search boxes from firing a request per keystroke). */
export function useDebounced<T>(value: T, delay = 350): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}
