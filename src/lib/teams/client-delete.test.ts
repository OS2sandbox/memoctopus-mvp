import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/storage', () => ({
  getMeeting: vi.fn(),
  deleteMeeting: vi.fn(),
}));

import { deleteMeeting, getMeeting } from '@/lib/storage';
import type { StoredMeeting } from '@/lib/storage';
import { deleteMeetingAndUnregister } from './client-delete';

const mockGet = vi.mocked(getMeeting);
const mockDeleteLocal = vi.mocked(deleteMeeting);
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const managed = { id: 'm1', source: 'teams', graphManaged: true } as StoredMeeting;

function respond(status: number) {
  mockFetch.mockResolvedValue({ ok: status >= 200 && status < 300, status } as Response);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDeleteLocal.mockResolvedValue(undefined);
  mockGet.mockResolvedValue(managed);
  respond(200);
});

describe('deleteMeetingAndUnregister', () => {
  it('unregisters a graph-managed meeting server-side first, then deletes it locally', async () => {
    await deleteMeetingAndUnregister('m1');

    expect(mockFetch).toHaveBeenCalledWith('/api/teams/meetings/m1', { method: 'DELETE' });
    expect(mockDeleteLocal).toHaveBeenCalledWith('m1');
    expect(mockFetch.mock.invocationCallOrder[0]).toBeLessThan(
      mockDeleteLocal.mock.invocationCallOrder[0],
    );
  });

  it('deletes locally when the server has no such row (404)', async () => {
    respond(404);
    await deleteMeetingAndUnregister('m1');
    expect(mockDeleteLocal).toHaveBeenCalledWith('m1');
  });

  it('keeps the local meeting and throws when the request itself fails', async () => {
    mockFetch.mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(deleteMeetingAndUnregister('m1')).rejects.toThrow();

    expect(mockDeleteLocal).not.toHaveBeenCalled();
  });

  it('keeps the local meeting and throws on a 5xx', async () => {
    respond(502);

    await expect(deleteMeetingAndUnregister('m1')).rejects.toThrow();

    expect(mockDeleteLocal).not.toHaveBeenCalled();
  });

  it('keeps the local meeting on an expired session (401): retrying after login can still stop it', async () => {
    respond(401);

    await expect(deleteMeetingAndUnregister('m1')).rejects.toThrow();

    expect(mockDeleteLocal).not.toHaveBeenCalled();
  });

  it('only deletes locally for a meeting that is not graph-managed', async () => {
    mockGet.mockResolvedValue({ id: 'm1', source: 'local' } as StoredMeeting);

    await deleteMeetingAndUnregister('m1');

    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockDeleteLocal).toHaveBeenCalledWith('m1');
  });

  it('leaves a legacy bot meeting (teams, no graphManaged marker) alone on the server', async () => {
    mockGet.mockResolvedValue({ id: 'm1', source: 'teams' } as StoredMeeting);

    await deleteMeetingAndUnregister('m1');

    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockDeleteLocal).toHaveBeenCalledWith('m1');
  });

  it('still runs the local delete for a meeting that is already gone locally', async () => {
    mockGet.mockResolvedValue(null);

    await deleteMeetingAndUnregister('m1');

    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockDeleteLocal).toHaveBeenCalledWith('m1');
  });

  it('percent-encodes the id in the URL', async () => {
    await deleteMeetingAndUnregister('a/b');
    expect(mockFetch).toHaveBeenCalledWith('/api/teams/meetings/a%2Fb', { method: 'DELETE' });
  });
});
