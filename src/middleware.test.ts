import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from './middleware';

function makeReq(pathname: string, cookies: Record<string, string> = {}): NextRequest {
  const url = `http://localhost${pathname}`;
  const req = new NextRequest(url);
  for (const [name, value] of Object.entries(cookies)) {
    req.cookies.set(name, value);
  }
  return req;
}

const SESSION_COOKIE = 'better-auth.session_token';
const SECURE_SESSION_COOKIE = '__Secure-better-auth.session_token';
const TOKEN = 'valid-token-abc';

describe('middleware', () => {
  describe('/sign-in redirect', () => {
    it('redirects /sign-in to / regardless of auth state', () => {
      const res = middleware(makeReq('/sign-in'));
      expect(res.status).toBe(307);
      expect(res.headers.get('location')).toBe('http://localhost/');
    });

    it('redirects /sign-in to / even when a session token is present', () => {
      const res = middleware(makeReq('/sign-in', { [SESSION_COOKIE]: TOKEN }));
      expect(res.status).toBe(307);
      expect(res.headers.get('location')).toBe('http://localhost/');
    });
  });

  describe('landing page (/)', () => {
    it('passes through unauthenticated requests to /', () => {
      const res = middleware(makeReq('/'));
      expect(res.status).toBe(200);
    });

    it('redirects authenticated users from / to /dashboard', () => {
      const res = middleware(makeReq('/', { [SESSION_COOKIE]: TOKEN }));
      expect(res.status).toBe(307);
      expect(res.headers.get('location')).toBe('http://localhost/dashboard');
    });

    // The middleware only sees that a cookie exists; (app)/layout.tsx is what
    // actually validates it. A cookie that outlives its session row makes the two
    // disagree, and bouncing it to /dashboard just to be sent back here is an
    // infinite loop that locks the user out of the login page. The layout sets
    // this marker precisely to stop that.
    it('renders the landing page for a rejected session instead of looping', () => {
      const res = middleware(makeReq('/?session_expired=1', { [SESSION_COOKIE]: TOKEN }));
      expect(res.headers.get('location')).toBeNull();
      expect(res.status).toBe(200);
    });

    it('honours the marker for the secure cookie variant too', () => {
      const res = middleware(makeReq('/?session_expired=1', { [SECURE_SESSION_COOKIE]: TOKEN }));
      expect(res.headers.get('location')).toBeNull();
    });

    it('still redirects to /dashboard when the marker is absent', () => {
      const res = middleware(makeReq('/?from=%2Fdashboard', { [SESSION_COOKIE]: TOKEN }));
      expect(res.status).toBe(307);
      expect(res.headers.get('location')).toBe('http://localhost/dashboard');
    });

    it('redirects to /dashboard when the secure cookie variant is set', () => {
      const res = middleware(makeReq('/', { [SECURE_SESSION_COOKIE]: TOKEN }));
      expect(res.status).toBe(307);
      expect(res.headers.get('location')).toBe('http://localhost/dashboard');
    });
  });

  describe('protected routes', () => {
    it('passes through authenticated requests to /dashboard', () => {
      const res = middleware(makeReq('/dashboard', { [SESSION_COOKIE]: TOKEN }));
      expect(res.status).toBe(200);
    });

    it('passes through authenticated requests to a nested protected path', () => {
      const res = middleware(makeReq('/dashboard/meetings/meet-1', { [SESSION_COOKIE]: TOKEN }));
      expect(res.status).toBe(200);
    });

    it('redirects unauthenticated requests to /', () => {
      const res = middleware(makeReq('/dashboard'));
      expect(res.status).toBe(307);
      const location = new URL(res.headers.get('location')!);
      expect(location.pathname).toBe('/');
    });

    it('includes the original path as the "from" query param on redirect', () => {
      const res = middleware(makeReq('/dashboard'));
      const location = new URL(res.headers.get('location')!);
      expect(location.searchParams.get('from')).toBe('/dashboard');
    });

    it('preserves the full "from" path for nested routes', () => {
      const res = middleware(makeReq('/dashboard/meetings/meet-42'));
      const location = new URL(res.headers.get('location')!);
      expect(location.searchParams.get('from')).toBe('/dashboard/meetings/meet-42');
    });

    it('recognises the secure cookie variant as a valid session', () => {
      const res = middleware(makeReq('/dashboard', { [SECURE_SESSION_COOKIE]: TOKEN }));
      expect(res.status).toBe(200);
    });

    it('redirects when neither cookie variant is present', () => {
      const res = middleware(makeReq('/settings'));
      expect(res.status).toBe(307);
    });
  });
});
