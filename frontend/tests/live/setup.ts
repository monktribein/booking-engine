import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => cleanup());

// jsdom has no IntersectionObserver; the redesign's scroll animations (framer-motion whileInView) need one. This stub never reports
// an intersection, so nothing animates in tests and the content stays in the DOM.
if (typeof globalThis.IntersectionObserver === 'undefined') {
  class StubIntersectionObserver {
    readonly root = null;
    readonly rootMargin = '';
    readonly thresholds: ReadonlyArray<number> = [];
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  }
  (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = StubIntersectionObserver;
}
