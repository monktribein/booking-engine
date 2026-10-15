import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach } from 'vitest';
import { __resetClientStateForTests } from '@/lib/api/client';

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  __resetClientStateForTests();
});

afterEach(() => {
  cleanup();
});
