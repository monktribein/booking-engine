'use client';

import { RefObject, useEffect, useRef } from 'react';

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

const focusableIn = (root: HTMLElement) =>
  [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => !el.hasAttribute('aria-hidden') && el.getClientRects().length > 0);

/**
 * Keyboard behaviour of a modal dialog or drawer:
 *  - on open, focus moves inside (the first form field if there is one, otherwise the first control);
 *  - Tab and Shift+Tab cycle within it, never to the page behind;
 *  - Escape closes it;
 *  - on close, focus returns to the control that opened it.
 * `onClose` may change on every render; the latest one is used without re-running the effect.
 */
export function useModalFocus(isOpen: boolean, onClose: () => void, containerRef: RefObject<HTMLElement | null>) {
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose; // latest handler, without re-running the focus effect on every render
  });

  useEffect(() => {
    if (!isOpen) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const container = containerRef.current;
    if (container) {
      const items = focusableIn(container);
      const firstField = items.find((el) => /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName));
      (firstField ?? items[0] ?? container).focus();
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeRef.current();
        return;
      }
      if (e.key !== 'Tab' || !containerRef.current) return;
      const items = focusableIn(containerRef.current);
      if (items.length === 0) {
        e.preventDefault();
        containerRef.current.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (!containerRef.current.contains(active)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.body.style.overflow = '';
      if (opener && document.contains(opener)) opener.focus();
    };
  }, [isOpen, containerRef]);
}
