import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('next/headers', () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

vi.mock('@/lib/auth', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

const mockConcat = vi.hoisted(() => vi.fn());
vi.mock('@/lib/audio/concat-server', () => ({ concatToMono16kFlac: mockConcat }));

import { NextRequest } from 'next/server';
import { POST } from './route';
import { auth } from '@/lib/auth';
import { FAKE_SESSION } from '@/test/helpers';

const mockGetSession = vi.mocked(auth.api.getSession);

function makeRequest(contents: string[]): NextRequest {
  const formData = new FormData();
  contents.forEach((text, i) => formData.append('audio', new File([text], `del-${i}.m4a`, { type: 'audio/mp4' })));
  return new NextRequest('http://localhost/api/audio/concat', { method: 'POST', body: formData });
}

beforeEach(() => {
  mockGetSession.mockReset().mockResolvedValue(FAKE_SESSION as never);
  mockConcat.mockReset();
});

describe('POST /api/audio/concat', () => {
  it('returns 401 without a session', async () => {
    mockGetSession.mockResolvedValueOnce(null as never);
    const res = await POST(makeRequest(['first', 'second']));
    expect(res.status).toBe(401);
    expect(mockConcat).not.toHaveBeenCalled();
  });

  it.each([
    ['no files', []],
    ['one file', ['only']],
    ['an empty file', ['first', '']],
  ])('returns 400 with %s', async (_label, contents) => {
    const res = await POST(makeRequest(contents));
    expect(res.status).toBe(400);
    expect(mockConcat).not.toHaveBeenCalled();
  });

  it('returns 400 when an audio field is text rather than a file', async () => {
    const formData = new FormData();
    formData.append('audio', new File(['first'], 'a.m4a'));
    formData.append('audio', 'second');
    const res = await POST(new NextRequest('http://localhost/api/audio/concat', { method: 'POST', body: formData }));
    expect(res.status).toBe(400);
    expect(mockConcat).not.toHaveBeenCalled();
  });

  it('joins the files in form order and answers with the FLAC', async () => {
    mockConcat.mockResolvedValueOnce(Buffer.from('fLaC-joined'));

    const res = await POST(makeRequest(['first', 'second', 'third']));

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('audio/flac');
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('fLaC-joined');
    const [buffers] = mockConcat.mock.calls[0] as [Buffer[]];
    expect(buffers.map((b) => b.toString())).toEqual(['first', 'second', 'third']);
  });
});
