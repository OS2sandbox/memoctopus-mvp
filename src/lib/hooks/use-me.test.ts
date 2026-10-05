// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useMe } from './use-me';

const ME = {
  user: { id: 'u1', name: 'Anne', email: 'a@example.dk' },
  roles: ['tt-bruger'],
  capabilities: ['template.use'],
  scopes: {},
  source: 'local',
  readOnly: false,
};

const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('useMe', () => {
  it('starts loading with no data', () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useMe());
    expect(result.current).toMatchObject({ data: null, loading: true, error: null });
    expect(fetchMock).toHaveBeenCalledWith('/api/me');
  });

  it('returns the data on success', async () => {
    fetchMock.mockReturnValue(json(ME));
    const { result } = renderHook(() => useMe());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data?.user.id).toBe('u1');
    expect(result.current.error).toBeNull();
  });

  it('reports a Danish error and no data on HTTP failure', async () => {
    fetchMock.mockReturnValue(json({ error: 'Forbidden' }, 403));
    const { result } = renderHook(() => useMe());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toBeNull();
    expect(result.current.error).toBe('Kunne ikke hente dine rettigheder.');
  });

  it('reports an error on a network failure', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useMe());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toBeNull();
    expect(result.current.error).not.toBeNull();
  });

  it('treats a malformed body as an error, not as data', async () => {
    fetchMock.mockReturnValue(json({ hello: 'world' }));
    const { result } = renderHook(() => useMe());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toBeNull();
    expect(result.current.error).not.toBeNull();
  });

  it('refetches on reload', async () => {
    fetchMock.mockImplementation(() => json(ME));
    const { result } = renderHook(() => useMe());
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.reload());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.loading).toBe(false));
  });

  it('does not update state after unmount', async () => {
    let resolve!: (r: Response) => void;
    fetchMock.mockReturnValue(new Promise<Response>((r) => (resolve = r)));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { unmount } = renderHook(() => useMe());
    unmount();
    resolve(new Response(JSON.stringify(ME), { status: 200 }));
    await new Promise((r) => setTimeout(r, 0));
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
