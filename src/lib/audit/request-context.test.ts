import { afterEach, describe, expect, it, vi } from 'vitest';
import { asHeaderSource, clientIp, requestContext, requestIdOf, userAgentOf } from './request-context';

const req = (h: Record<string, string>) => ({ headers: new Headers(h) });

afterEach(() => vi.unstubAllEnvs());

describe('clientIp', () => {
  it('uses the first entry of x-forwarded-for by default', () => {
    expect(clientIp(req({ 'x-forwarded-for': '203.0.113.5, 10.0.0.1' }))).toBe('203.0.113.5');
  });
  it('returns null when there is no usable header', () => {
    expect(clientIp(req({}))).toBeNull();
    expect(clientIp(req({ 'x-forwarded-for': 'unknown' }))).toBeNull();
    expect(clientIp(req({ 'x-forwarded-for': 'Vi skal tale om sagen' }))).toBeNull();
  });
  it('reuses AUTH_IP_HEADERS: only the configured headers are trusted, in order', () => {
    vi.stubEnv('AUTH_IP_HEADERS', 'x-real-ip, X-Forwarded-For');
    expect(clientIp(req({ 'x-real-ip': '198.51.100.2', 'x-forwarded-for': '203.0.113.5' }))).toBe('198.51.100.2');
    expect(clientIp(req({ 'x-forwarded-for': '203.0.113.5' }))).toBe('203.0.113.5');
    vi.stubEnv('AUTH_IP_HEADERS', 'x-real-ip');
    expect(clientIp(req({ 'x-forwarded-for': '203.0.113.5' }))).toBeNull();
  });
  it('strips ports and brackets and accepts IPv6', () => {
    expect(clientIp(req({ 'x-forwarded-for': '203.0.113.5:4433' }))).toBe('203.0.113.5');
    expect(clientIp(req({ 'x-forwarded-for': '[2001:db8::1]:443' }))).toBe('2001:db8::1');
    expect(clientIp(req({ 'x-forwarded-for': '2001:db8::1' }))).toBe('2001:db8::1');
  });
});

describe('userAgentOf', () => {
  it('truncates to 255 characters and strips control characters', () => {
    expect(userAgentOf(req({ 'user-agent': 'x'.repeat(400) }))).toHaveLength(255);
    expect(userAgentOf(req({ 'user-agent': 'Mozilla/5.0' }))).toBe('Mozilla/5.0');
    expect(userAgentOf(req({}))).toBeNull();
  });
});

describe('requestIdOf', () => {
  it('reads an x-request-id shaped like a UUID or a 32-digit hex id', () => {
    const uuid = '3f2b8c1e-5a47-4d9b-9c3e-0a1b2c3d4e5f';
    expect(requestIdOf(req({ 'x-request-id': uuid }))).toBe(uuid);
    expect(requestIdOf(req({ 'x-request-id': 'a1b2c3d4e5f60718293a4b5c6d7e8f90' }))).toBe('a1b2c3d4e5f60718293a4b5c6d7e8f90');
  });
  it('ignores an id that is merely a whitespace-free token, so callers cannot plant text in audit rows', () => {
    expect(requestIdOf(req({ 'x-request-id': 'abc-123' }))).toMatch(/^[0-9a-f-]{36}$/);
    expect(requestIdOf(req({ 'x-request-id': 'Some_Name.Here-0123456789' }))).toMatch(/^[0-9a-f-]{36}$/);
  });
  it('generates one when absent or unsafe, stable per request object', () => {
    const a = req({});
    const first = requestIdOf(a);
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(requestIdOf(a)).toBe(first);
    expect(requestIdOf(req({}))).not.toBe(first);
    expect(requestIdOf(req({ 'x-request-id': 'two words' }))).toMatch(/^[0-9a-f-]{36}$/);
    expect(requestIdOf(req({ 'x-request-id': 'a'.repeat(65) }))).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('requestContext / asHeaderSource', () => {
  it('bundles ip, user agent and request id', () => {
    expect(requestContext(req({ 'x-forwarded-for': '203.0.113.5', 'user-agent': 'UA', 'x-request-id': 'a1b2c3d4e5f60718293a4b5c6d7e8f90' }))).toEqual({
      ip: '203.0.113.5',
      userAgent: 'UA',
      requestId: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
    });
  });
  it('recognises request-like values only', () => {
    expect(asHeaderSource(new Request('http://x.test'))).not.toBeNull();
    expect(asHeaderSource('req')).toBeNull();
    expect(asHeaderSource(null)).toBeNull();
    expect(asHeaderSource({ headers: {} })).toBeNull();
  });
});
