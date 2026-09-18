import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Readable } from 'stream';

const mockGraphJson = vi.hoisted(() => vi.fn());
const mockGraphFetch = vi.hoisted(() => vi.fn());
const mockGetToken = vi.hoisted(() => vi.fn(async () => 'tok-123'));

vi.mock('./graph-client', async () => {
  const actual = await vi.importActual<typeof import('./graph-client')>('./graph-client');
  return {
    GraphError: actual.GraphError,
    graphOrigin: () => 'https://graph.microsoft.com/v1.0',
    graphJson: mockGraphJson,
    graphFetch: mockGraphFetch,
    getGraphAccessToken: mockGetToken,
  };
});

import { GraphError } from './graph-client';
import { listArtifacts, pickArtifact, downloadTranscriptVtt, downloadRecording } from './artifacts';

const MEETING = 'MSpiZGE=';

beforeEach(() => {
  mockGraphJson.mockReset();
  mockGraphFetch.mockReset();
  mockGetToken.mockReset().mockResolvedValue('tok-123');
});

describe('listArtifacts', () => {
  it('lists transcripts and recordings from the meeting', async () => {
    mockGraphJson.mockImplementation(async (_u: string, path: string) => {
      if (path.endsWith('/transcripts')) {
        return { value: [{ id: 't1', createdDateTime: '2026-09-08T10:00:00Z', endDateTime: null }] };
      }
      return { value: [{ id: 'r1', createdDateTime: '2026-09-08T10:05:00Z' }] };
    });

    const refs = await listArtifacts('u1', MEETING);

    expect(refs.transcripts).toEqual([
      { id: 't1', createdDateTime: '2026-09-08T10:00:00Z', endDateTime: null },
    ]);
    expect(refs.recordings).toEqual([
      { id: 'r1', createdDateTime: '2026-09-08T10:05:00Z', endDateTime: null },
    ]);
    // The meeting id is URL-encoded into the path (Graph ids contain '=' and '/').
    expect(mockGraphJson.mock.calls[0][1]).toContain(encodeURIComponent(MEETING));
  });

  it('treats a 404 collection as empty, not an error', async () => {
    mockGraphJson.mockImplementation(async (_u: string, path: string) => {
      if (path.endsWith('/transcripts')) throw new GraphError('not_found', 'nope', { status: 404 });
      return { value: [{ id: 'r1', createdDateTime: null }] };
    });

    const refs = await listArtifacts('u1', MEETING);
    expect(refs.transcripts).toEqual([]);
    expect(refs.recordings).toHaveLength(1);
  });

  it('propagates a transcripts_disabled 403', async () => {
    mockGraphJson.mockRejectedValue(new GraphError('transcripts_disabled', 'slået fra', { status: 403 }));
    await expect(listArtifacts('u1', MEETING)).rejects.toMatchObject({ code: 'transcripts_disabled' });
  });

  it('skips entries without an id and returns empty for an empty collection', async () => {
    mockGraphJson.mockResolvedValue({ value: [{ createdDateTime: '2026-09-08T10:00:00Z' }] });
    const refs = await listArtifacts('u1', MEETING);
    expect(refs.transcripts).toEqual([]);
    expect(refs.recordings).toEqual([]);
  });
});

describe('pickArtifact', () => {
  const items = [
    { id: 'a', createdDateTime: '2026-09-01T09:00:00Z' },
    { id: 'b', createdDateTime: '2026-09-08T09:30:00Z' },
    { id: 'c', createdDateTime: '2026-09-15T09:00:00Z' },
  ];

  it('returns null for an empty list', () => {
    expect(pickArtifact([])).toBeNull();
  });

  it('picks the newest when no window is given', () => {
    expect(pickArtifact(items)?.id).toBe('c');
  });

  it('picks the occurrence inside the window of a recurring series', () => {
    const picked = pickArtifact(items, {
      start: new Date('2026-09-08T09:00:00Z'),
      end: new Date('2026-09-08T10:00:00Z'),
    });
    expect(picked?.id).toBe('b');
  });

  it('accepts an artifact up to an hour before the start and six hours after the end', () => {
    const window = { start: new Date('2026-09-08T10:00:00Z'), end: new Date('2026-09-08T11:00:00Z') };
    expect(pickArtifact([{ id: 'early', createdDateTime: '2026-09-08T09:15:00Z' }], window)?.id).toBe('early');
    expect(pickArtifact([{ id: 'late', createdDateTime: '2026-09-08T16:30:00Z' }], window)?.id).toBe('late');
    expect(pickArtifact([{ id: 'tooEarly', createdDateTime: '2026-09-08T08:00:00Z' }], window)).toBeNull();
    expect(pickArtifact([{ id: 'tooLate', createdDateTime: '2026-09-08T17:30:00Z' }], window)).toBeNull();
  });

  it('picks the newest inside the window when several occurrences match', () => {
    const window = { start: new Date('2026-09-08T10:00:00Z'), end: new Date('2026-09-08T11:00:00Z') };
    const picked = pickArtifact(
      [
        { id: 'first', createdDateTime: '2026-09-08T10:10:00Z' },
        { id: 'second', createdDateTime: '2026-09-08T11:10:00Z' },
      ],
      window,
    );
    expect(picked?.id).toBe('second');
  });

  it('ignores undated artifacts when a window is given, but falls back to them otherwise', () => {
    const undated = [{ id: 'x', createdDateTime: null }, { id: 'y', createdDateTime: null }];
    expect(pickArtifact(undated, { start: new Date(), end: new Date() })).toBeNull();
    expect(pickArtifact(undated)?.id).toBe('y'); // Graph lists newest last
  });
});

describe('downloadTranscriptVtt', () => {
  it('requests the VTT format and returns the body text', async () => {
    mockGraphFetch.mockResolvedValue(new Response('WEBVTT\n\n'));
    const vtt = await downloadTranscriptVtt('u1', MEETING, 't1');
    expect(vtt).toBe('WEBVTT\n\n');
    const path = mockGraphFetch.mock.calls[0][1] as string;
    expect(path).toContain('/transcripts/t1/content');
    expect(path).toContain('$format=text/vtt');
  });
});

describe('downloadRecording', () => {
  let dir: string;
  const realFetch = globalThis.fetch;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'artifacts-test-'));
  });
  afterEach(async () => {
    globalThis.fetch = realFetch;
    await rm(dir, { recursive: true, force: true });
  });

  function bodyResponse(text: string): Response {
    const stream = Readable.toWeb(Readable.from([Buffer.from(text)])) as ReadableStream;
    return new Response(stream, { status: 200 });
  }

  it('streams the body to disk and reports the byte count', async () => {
    const fetchMock = vi.fn(async () => bodyResponse('mp4-bytes'));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const dest = join(dir, 'rec.mp4');
    const { bytes } = await downloadRecording('u1', MEETING, 'r1', dest);

    expect(bytes).toBe(9);
    expect(await readFile(dest, 'utf8')).toBe('mp4-bytes');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/recordings/r1/content');
    expect(init.redirect).toBe('manual');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok-123');
  });

  it('follows the 302 to storage without leaking the bearer token', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://contoso.sharepoint.com/signed' } }))
      .mockResolvedValueOnce(bodyResponse('abc'));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await downloadRecording('u1', MEETING, 'r1', join(dir, 'rec.mp4'));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(url).toBe('https://contoso.sharepoint.com/signed');
    expect(init.headers).toEqual({});
  });

  it('keeps the bearer on a redirect that stays on the Graph origin', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://graph.microsoft.com/v1.0/other' } }))
      .mockResolvedValueOnce(bodyResponse('abc'));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await downloadRecording('u1', MEETING, 'r1', join(dir, 'rec.mp4'));
    const [, init] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok-123');
  });

  it('maps a non-2xx download onto a typed GraphError', async () => {
    globalThis.fetch = vi.fn(async () => new Response('no', { status: 404 })) as unknown as typeof fetch;
    await expect(downloadRecording('u1', MEETING, 'r1', join(dir, 'rec.mp4')))
      .rejects.toMatchObject({ name: 'GraphError', code: 'not_found' });

    globalThis.fetch = vi.fn(async () => new Response('no', { status: 401 })) as unknown as typeof fetch;
    await expect(downloadRecording('u1', MEETING, 'r1', join(dir, 'rec.mp4')))
      .rejects.toMatchObject({ code: 'reauth_required' });
  });

  it('fails when a redirect has no location header', async () => {
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 302 })) as unknown as typeof fetch;
    await expect(downloadRecording('u1', MEETING, 'r1', join(dir, 'rec.mp4')))
      .rejects.toMatchObject({ name: 'GraphError' });
  });
});
