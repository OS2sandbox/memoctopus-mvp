import { createWriteStream } from 'fs';
import { Readable } from 'stream';
import { pipeline as streamPipeline } from 'stream/promises';
import { GraphError, graphFetch, graphJson, getGraphAccessToken, graphOrigin } from './graph-client';

// Reading a meeting's artifacts out of Microsoft Graph: the Teams transcript (VTT,
// with `<v Display Name>` cues) and the recording (mp4). Both live under the
// online meeting and are listed newest-last by Graph; we pick per occurrence,
// because a recurring series has ONE onlineMeeting id and many artifacts.

export interface ArtifactRef {
  id: string;
  createdDateTime: string | null;
  endDateTime: string | null;
}

export interface ArtifactRefs {
  transcripts: ArtifactRef[];
  recordings: ArtifactRef[];
}

interface GraphListResponse {
  value?: {
    id?: string;
    createdDateTime?: string | null;
    endDateTime?: string | null;
    meetingOrganizer?: unknown;
  }[];
}

/** Occurrence window slack: Teams stamps artifacts around, not exactly at, the meeting. */
const WINDOW_BEFORE_MS = 60 * 60 * 1000; // 1 h before the scheduled start
const WINDOW_AFTER_MS = 6 * 60 * 60 * 1000; // 6 h after the scheduled end

function encodeId(id: string): string {
  return encodeURIComponent(id);
}

function toRefs(body: GraphListResponse): ArtifactRef[] {
  return (body.value ?? [])
    .filter((item): item is { id: string } & typeof item => typeof item.id === 'string' && item.id.length > 0)
    .map((item) => ({
      id: item.id,
      createdDateTime: item.createdDateTime ?? null,
      endDateTime: item.endDateTime ?? null,
    }));
}

// A meeting that never recorded/transcribed simply has no collection yet: Graph
// answers 404. That is "nothing yet", not an error — the poller keeps waiting.
// A `transcripts_disabled` 403 is different (the tenant blocked Graph access)
// and must reach the user, so it propagates.
async function listOne(userId: string, path: string): Promise<ArtifactRef[]> {
  try {
    return toRefs(await graphJson<GraphListResponse>(userId, path));
  } catch (err) {
    if (err instanceof GraphError && err.code === 'not_found') return [];
    throw err;
  }
}

export async function listArtifacts(userId: string, graphMeetingId: string): Promise<ArtifactRefs> {
  const base = `/me/onlineMeetings/${encodeId(graphMeetingId)}`;
  const [transcripts, recordings] = await Promise.all([
    listOne(userId, `${base}/transcripts`),
    listOne(userId, `${base}/recordings`),
  ]);
  return { transcripts, recordings };
}

/**
 * Newest artifact, optionally restricted to one occurrence of a recurring series.
 * Items without a createdDateTime are only used when nothing else matches (and
 * never inside a window, since they cannot be placed in time).
 */
export function pickArtifact<T extends { createdDateTime: string | null }>(
  items: T[],
  window?: { start: Date; end: Date },
): T | null {
  const dated = items
    .map((item) => ({ item, at: item.createdDateTime ? Date.parse(item.createdDateTime) : NaN }))
    .filter((entry) => Number.isFinite(entry.at));

  if (window) {
    const from = window.start.getTime() - WINDOW_BEFORE_MS;
    const to = window.end.getTime() + WINDOW_AFTER_MS;
    const inWindow = dated.filter((entry) => entry.at >= from && entry.at <= to);
    if (inWindow.length === 0) return null;
    return inWindow.reduce((best, entry) => (entry.at > best.at ? entry : best)).item;
  }

  if (dated.length > 0) {
    return dated.reduce((best, entry) => (entry.at > best.at ? entry : best)).item;
  }
  // No usable timestamps at all — fall back to Graph's own order (newest last).
  return items.length > 0 ? items[items.length - 1] : null;
}

export async function downloadTranscriptVtt(
  userId: string,
  graphMeetingId: string,
  transcriptId: string,
): Promise<string> {
  const res = await graphFetch(
    userId,
    `/me/onlineMeetings/${encodeId(graphMeetingId)}/transcripts/${encodeId(transcriptId)}/content?$format=text/vtt`,
  );
  return await res.text();
}

/** Map a failed recording-download response onto the same typed errors graphFetch uses. */
function downloadError(status: number): GraphError {
  if (status === 401) {
    return new GraphError('reauth_required', 'Microsoft afviste tokenet under hentning af optagelsen', { status });
  }
  if (status === 403) {
    return new GraphError('forbidden', 'Ingen adgang til optagelsen', { status });
  }
  if (status === 404) {
    return new GraphError('not_found', 'Optagelsen findes ikke', { status });
  }
  return new GraphError('http', `Microsoft Graph svarede ${status} på optagelsen`, { status });
}

/**
 * Stream a recording to disk. Recordings run to hundreds of MB, so the body is
 * never buffered in memory. Graph 302s recording content to a pre-signed
 * SharePoint/blob URL; redirects are followed by hand with `redirect: 'manual'`
 * so the bearer is dropped the moment we leave the Graph origin.
 */
export async function downloadRecording(
  userId: string,
  graphMeetingId: string,
  recordingId: string,
  destPath: string,
): Promise<{ bytes: number }> {
  const origin = graphOrigin();
  let url = `${origin}/me/onlineMeetings/${encodeId(graphMeetingId)}/recordings/${encodeId(recordingId)}/content`;
  let headers: Record<string, string> = { Authorization: `Bearer ${await getGraphAccessToken(userId)}` };

  let res = await fetch(url, { redirect: 'manual', headers });
  for (let hop = 0; res.status >= 300 && res.status < 400 && hop < 5; hop++) {
    const location = res.headers.get('location');
    if (!location) throw downloadError(res.status);
    url = new URL(location, url).href;
    // Off-Graph storage hosts carry their own signature in the URL; sending our
    // token there would leak it.
    if (!sameOrigin(url, origin)) headers = {};
    res = await fetch(url, { redirect: 'manual', headers });
  }

  if (!res.ok) throw downloadError(res.status);
  if (!res.body) throw new GraphError('http', 'Optagelsen fra Microsoft Teams var tom', { status: res.status });

  let bytes = 0;
  const source = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
  source.on('data', (chunk: Buffer | string) => {
    bytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
  });
  await streamPipeline(source, createWriteStream(destPath));
  return { bytes };
}

function sameOrigin(url: string, base: string): boolean {
  try {
    return new URL(url).origin === new URL(base).origin;
  } catch {
    return false;
  }
}
