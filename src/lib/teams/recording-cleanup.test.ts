import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./graph-client', async () => {
  // GraphError is the real class; only the network is replaced.
  const actual = await vi.importActual<typeof import('./graph-client')>('./graph-client');
  return { ...actual, graphFetch: vi.fn(), graphJson: vi.fn(), hasGraphScopes: vi.fn() };
});
vi.mock('@/lib/auth', () => ({ auth: { api: {} } }));

import { GraphError, graphFetch, graphJson, hasGraphScopes } from './graph-client';
import { deleteRecordingFromDrive } from './recording-cleanup';

const mockFetch = vi.mocked(graphFetch);
const mockJson = vi.mocked(graphJson);
const mockScopes = vi.mocked(hasGraphScopes);

const file = (id: string, size: number, driveId: string | null = 'drive-1') => ({
  id,
  size,
  file: { mimeType: 'video/mp4' },
  ...(driveId ? { parentReference: { driveId } } : {}),
});

beforeEach(() => {
  vi.clearAllMocks();
  mockFetch.mockResolvedValue(new Response(null, { status: 204 }));
  mockScopes.mockResolvedValue({ ok: true, missing: [] });
});

describe('deleteRecordingFromDrive', () => {
  it('permanently deletes the one file whose size matches to the byte', async () => {
    mockJson.mockResolvedValueOnce({ value: [file('a', 100), file('b', 4242), file('c', 4243)] });

    await expect(deleteRecordingFromDrive('u1', 4242)).resolves.toBe('deleted');

    expect(mockJson.mock.calls[0][1]).toMatch(/^\/me\/drive\/special\/recordings\/children\?/);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith('u1', '/drives/drive-1/items/b/permanentDelete', { method: 'POST' });
  });

  it('falls back to /me/drive when the item names no drive', async () => {
    mockJson.mockResolvedValueOnce({ value: [file('b', 4242, null)] });

    await deleteRecordingFromDrive('u1', 4242);

    expect(mockFetch.mock.calls[0][1]).toBe('/me/drive/items/b/permanentDelete');
  });

  it('follows @odata.nextLink to find it', async () => {
    mockJson
      .mockResolvedValueOnce({ value: [file('a', 1)], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/next' })
      .mockResolvedValueOnce({ value: [file('b', 4242)] });

    await expect(deleteRecordingFromDrive('u1', 4242)).resolves.toBe('deleted');

    expect(mockJson.mock.calls[1][1]).toBe('https://graph.microsoft.com/v1.0/next');
  });

  it('deletes nothing when no file has that size', async () => {
    mockJson.mockResolvedValueOnce({ value: [file('a', 4241), file('c', 4243)] });

    await expect(deleteRecordingFromDrive('u1', 4242)).resolves.toBe('not_found');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('never deletes a folder, whatever its size', async () => {
    mockJson.mockResolvedValueOnce({ value: [{ id: 'dir', size: 4242, folder: { childCount: 3 } }] });

    await expect(deleteRecordingFromDrive('u1', 4242)).resolves.toBe('not_found');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('refuses to guess between two files of the same size', async () => {
    mockJson.mockResolvedValueOnce({ value: [file('a', 4242), file('b', 4242)] });

    await expect(deleteRecordingFromDrive('u1', 4242)).resolves.toBe('ambiguous');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('reads a missing Recordings folder as nothing to delete', async () => {
    mockJson.mockRejectedValueOnce(new GraphError('not_found', 'ingen mappe', { status: 404 }));

    await expect(deleteRecordingFromDrive('u1', 4242)).resolves.toBe('not_found');
  });

  it('moves the file to the recycle bin when the tenant refuses a permanent delete', async () => {
    mockJson.mockResolvedValueOnce({ value: [file('b', 4242)] });
    mockFetch.mockRejectedValueOnce(new GraphError('forbidden', 'retention', { status: 403 }));

    await expect(deleteRecordingFromDrive('u1', 4242)).resolves.toBe('recycled');

    expect(mockFetch).toHaveBeenLastCalledWith('u1', '/drives/drive-1/items/b', { method: 'DELETE' });
  });

  it('treats a file that vanished before the delete as deleted', async () => {
    mockJson.mockResolvedValueOnce({ value: [file('b', 4242)] });
    mockFetch.mockRejectedValueOnce(new GraphError('not_found', 'væk', { status: 404 }));

    await expect(deleteRecordingFromDrive('u1', 4242)).resolves.toBe('deleted');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a throttle', new GraphError('unavailable', 'throttled', { status: 429 })],
    ['a dead sign-in', new GraphError('reauth_required', 'log ind', { status: 401 })],
  ])('lets %s on the delete through, without settling for the recycle bin', async (_n, err) => {
    mockJson.mockResolvedValueOnce({ value: [file('b', 4242)] });
    mockFetch.mockRejectedValueOnce(err);

    await expect(deleteRecordingFromDrive('u1', 4242)).rejects.toBe(err);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('asks for a new sign-in, and touches nothing, without the files scope', async () => {
    mockScopes.mockResolvedValue({ ok: false, missing: ['Files.ReadWrite'] });

    await expect(deleteRecordingFromDrive('u1', 4242)).rejects.toMatchObject({
      code: 'consent_required',
      missingScopes: ['Files.ReadWrite'],
    });
    expect(mockJson).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('lets a failed listing through', async () => {
    const err = new GraphError('unavailable', 'nede', { status: 503 });
    mockJson.mockRejectedValueOnce(err);

    await expect(deleteRecordingFromDrive('u1', 4242)).rejects.toBe(err);
  });
});
