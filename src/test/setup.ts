import '@testing-library/jest-dom';
import { vi } from 'vitest';

// The audit seam persists to Postgres. Route and service tests that do not mock
// it themselves must not open a real pool (it would fail after the test ended and
// log into a torn-down worker). Tests of the seam itself call vi.unmock('./seam').
vi.mock('@/lib/audit/seam', () => ({
  recordAdminAction: vi.fn(async () => {}),
  recordAuthzDenied: vi.fn(async () => {}),
}));

// jsdom has no matchMedia; useIsMobile() needs it. Default to desktop (no match).
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  window.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }) as unknown as MediaQueryList;
}
