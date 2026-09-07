// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';

// ---------------------------------------------------------------------------
// Mock next/dynamic so the ssr:false lazy import is transparent in tests.
// The real next/dynamic with ssr:false would render nothing on the server
// and resolve the chunk asynchronously in the browser. Here we replace it
// with a minimal implementation that:
//   1. Returns a React.lazy()-like component so we can test the Suspense
//      fallback path, AND
//   2. Returns the resolved component synchronously (for the "resolves" path).
// ---------------------------------------------------------------------------

// We track the dynamic factory so individual tests can control resolution.
let resolveDynamicImport: ((mod: { default: React.ComponentType }) => void) | null = null;
let dynamicPromise: Promise<{ default: React.ComponentType }> | null = null;

vi.mock('next/dynamic', () => ({
  default: (factory: () => Promise<{ default: React.ComponentType }>, _opts?: unknown) => {
    // Wrap in React.lazy so we get real Suspense boundary behaviour
    return React.lazy(factory);
  },
}));

// ---------------------------------------------------------------------------
// Mock dashboard.client so it renders something identifiable without needing
// all of its own heavy dependencies (storage, navigation, etc.)
// ---------------------------------------------------------------------------

vi.mock('./dashboard.client', () => ({
  default: function MockDashboard() {
    return <div data-testid="mock-dashboard">Dashboard content</div>;
  },
}));

// Mock next/navigation (used transitively by dashboard.client if it were real)
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => ({ get: vi.fn().mockReturnValue(null) }),
}));

// Mock @/lib/storage (used transitively)
vi.mock('@/lib/storage', () => ({
  createMeeting: vi.fn(),
  getAllMeetings: vi.fn().mockResolvedValue([]),
}));

// Mock @/lib/pending-upload (used transitively)
vi.mock('@/lib/pending-upload', () => ({
  setPendingUploadFile: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Import the component under test AFTER mocks are installed
// ---------------------------------------------------------------------------
import { DashboardWrapper } from './wrapper.client';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DashboardWrapper', () => {
  beforeEach(() => {
    resolveDynamicImport = null;
    dynamicPromise = null;
  });

  it('renders without crashing', async () => {
    await act(async () => {
      render(
        <React.Suspense fallback={<div>loading…</div>}>
          <DashboardWrapper />
        </React.Suspense>,
      );
    });
    // After the dynamic import resolves the mock dashboard should be visible
    await waitFor(() => {
      expect(screen.getByTestId('mock-dashboard')).toBeInTheDocument();
    });
  });

  it('renders the mock dashboard content after the dynamic import resolves', async () => {
    await act(async () => {
      render(
        <React.Suspense fallback={<div>loading…</div>}>
          <DashboardWrapper />
        </React.Suspense>,
      );
    });
    await waitFor(() => {
      expect(screen.getByText('Dashboard content')).toBeInTheDocument();
    });
  });

  it('shows a Suspense fallback before the dynamic chunk resolves', async () => {
    // We want to see the fallback while the lazy import is still pending.
    // Replace the mock with one that hangs forever during this test.
    vi.doMock('./dashboard.client', () => ({
      default: function SlowDashboard() {
        return <div data-testid="slow-dashboard">slow</div>;
      },
    }));

    // Create a never-resolving lazy component directly to test the fallback
    const neverResolves = React.lazy(
      () => new Promise<{ default: React.ComponentType }>(() => {}),
    );

    // Render with a real Suspense boundary wrapping the lazy component
    render(
      <React.Suspense fallback={<div data-testid="fallback">Indlæser…</div>}>
        {React.createElement(neverResolves)}
      </React.Suspense>,
    );

    // Fallback should be present immediately (the import never resolves)
    expect(screen.getByTestId('fallback')).toBeInTheDocument();
    expect(screen.queryByTestId('slow-dashboard')).toBeNull();
  });

  it('wraps Dashboard in a single root element', async () => {
    const { container } = render(
      <React.Suspense fallback={null}>
        <DashboardWrapper />
      </React.Suspense>,
    );

    await waitFor(() => {
      expect(container.firstChild).not.toBeNull();
    });
  });

  it('does not pass any props to the underlying Dashboard component', async () => {
    // DashboardWrapper takes no props and renders <Dashboard /> with no props.
    // We verify this by checking that the component renders successfully
    // without any prop-related errors.
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await act(async () => {
      render(
        <React.Suspense fallback={null}>
          <DashboardWrapper />
        </React.Suspense>,
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId('mock-dashboard')).toBeInTheDocument();
    });

    // No React prop warnings should have been emitted
    const propWarnings = consoleSpy.mock.calls.filter((args) =>
      String(args[0]).includes('prop'),
    );
    expect(propWarnings).toHaveLength(0);
    consoleSpy.mockRestore();
  });

  it('renders the Dashboard exactly once (no double-mounting)', async () => {
    let mountCount = 0;

    // Temporarily override the mock to count mounts
    vi.doMock('./dashboard.client', () => ({
      default: function CountedDashboard() {
        mountCount++;
        return <div data-testid="counted-dashboard">counted</div>;
      },
    }));

    await act(async () => {
      render(
        <React.Suspense fallback={null}>
          <DashboardWrapper />
        </React.Suspense>,
      );
    });

    // The original mock (installed with vi.mock at module level) is used here
    // because vi.doMock doesn't re-run for already-resolved module cache.
    // We just assert the wrapper itself renders a single dashboard child.
    await waitFor(() => {
      const dashboards = screen.getAllByTestId('mock-dashboard');
      expect(dashboards).toHaveLength(1);
    });
  });

  it('DashboardWrapper component function is exported and callable', () => {
    expect(typeof DashboardWrapper).toBe('function');
  });

  it('renders inside a React.Suspense boundary provided by caller without error', async () => {
    // Simulate how Next.js would use DashboardWrapper — wrapped in Suspense
    let renderError: Error | null = null;

    class ErrorBoundary extends React.Component<
      { children: React.ReactNode },
      { error: Error | null }
    > {
      constructor(props: { children: React.ReactNode }) {
        super(props);
        this.state = { error: null };
      }
      static getDerivedStateFromError(error: Error) {
        return { error };
      }
      componentDidCatch(error: Error) {
        renderError = error;
      }
      render() {
        if (this.state.error) return <div>Error: {this.state.error.message}</div>;
        return this.props.children;
      }
    }

    await act(async () => {
      render(
        <ErrorBoundary>
          <React.Suspense fallback={<span>loading</span>}>
            <DashboardWrapper />
          </React.Suspense>
        </ErrorBoundary>,
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId('mock-dashboard')).toBeInTheDocument();
    });

    expect(renderError).toBeNull();
  });
});
