import { createWriteStream } from 'fs';
import { Readable } from 'stream';
import { pipeline as streamPipeline } from 'stream/promises';
import {
  GRAPH_DOWNLOAD_TIMEOUT_MS,
  GraphError,
  asTransient,
  graphFetch,
  graphJson,
  graphOrigin,
} from './graph-client';

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
    // Nothing in the window is NOT the same as nothing at all: a meeting that ran
    // more than WINDOW_AFTER_MS over, or was held before WINDOW_BEFORE_MS of its
    // booking, has its artifact discarded here and is then lost for good.
    //
    // Falling through to the newest dated artifact would fix that — but it would
    // also hand one occurrence of a recurring series the transcript of another,
    // which is what this window exists to prevent, and createdDateTime alone cannot
    // tell "ran four hours over" from "last Tuesday". The honest discriminator is
    // the artifact's own span (ArtifactRef.endDateTime, already fetched and unused).
    // Blocked on confirming against a real tenant what Graph reports for a series'
    // occurrence and whether createdDateTime is call start or publication time.
    if (inWindow.length === 0) return null;
    return inWindow.reduce((best, entry) => (entry.at > best.at ? entry : best)).item;
  }

  if (dated.length > 0) {
    return dated.reduce((best, entry) => (entry.at > best.at ? entry : best)).item;
  }
  // No usable timestamps at all — fall back to Graph's own order (newest last).
  return items.length > 0 ? items[items.length - 1] : null;
}

/**
 * A meeting with no window is usually a reused link (a personal meeting room, or
 * a channel's). Artifacts further apart than this are different sittings.
 */
export const SESSION_GAP_MS = 2 * 60 * 60 * 1000;

function createdAt(ref: ArtifactRef): number {
  return ref.createdDateTime ? Date.parse(ref.createdDateTime) : NaN;
}

/**
 * Every transcript and recording that belongs to this meeting, oldest first —
 * not just the newest of each. Recording can be stopped and started again, and
 * each stretch is its own artifact; taking only the newest dropped the rest of
 * the meeting.
 *
 * With a window: everything in it (same bounds as {@link pickArtifact}). Without
 * one: the newest artifact and everything that ran up to it without a gap of
 * {@link SESSION_GAP_MS}, so a reused link does not pull in last week's
 * sitting. Undated artifacts cannot be placed, so they are only used when
 * nothing is dated, as {@link pickArtifact} does.
 */
export function selectArtifacts(
  transcripts: ArtifactRef[],
  recordings: ArtifactRef[],
  window?: { start: Date; end: Date },
): ArtifactRefs {
  const tagged = [
    ...transcripts.map((ref) => ({ ref, kind: 'transcripts' as const })),
    ...recordings.map((ref) => ({ ref, kind: 'recordings' as const })),
  ].filter((entry) => Number.isFinite(createdAt(entry.ref)));

  let chosen: typeof tagged;
  if (window) {
    const from = window.start.getTime() - WINDOW_BEFORE_MS;
    const to = window.end.getTime() + WINDOW_AFTER_MS;
    chosen = tagged.filter((entry) => createdAt(entry.ref) >= from && createdAt(entry.ref) <= to);
  } else if (tagged.length === 0) {
    const t = pickArtifact(transcripts);
    const r = pickArtifact(recordings);
    return { transcripts: t ? [t] : [], recordings: r ? [r] : [] };
  } else {
    const newestFirst = [...tagged].sort((a, b) => createdAt(b.ref) - createdAt(a.ref));
    chosen = [];
    let earliest = createdAt(newestFirst[0].ref);
    for (const entry of newestFirst) {
      const ended = entry.ref.endDateTime ? Date.parse(entry.ref.endDateTime) : NaN;
      const tail = Number.isFinite(ended) ? Math.max(ended, createdAt(entry.ref)) : createdAt(entry.ref);
      if (tail < earliest - SESSION_GAP_MS) break;
      chosen.push(entry);
      earliest = Math.min(earliest, createdAt(entry.ref));
    }
  }

  const oldestFirst = [...chosen].sort((a, b) => createdAt(a.ref) - createdAt(b.ref));
  return {
    transcripts: oldestFirst.filter((e) => e.kind === 'transcripts').map((e) => e.ref),
    recordings: oldestFirst.filter((e) => e.kind === 'recordings').map((e) => e.ref),
  };
}

export async function downloadTranscriptVtt(
  userId: string,
  graphMeetingId: string,
  transcriptId: string,
): Promise<string> {
  const res = await graphFetch(
    userId,
    `/me/onlineMeetings/${encodeId(graphMeetingId)}/transcripts/${encodeId(transcriptId)}/content?$format=text/vtt`,
    {},
    { timeoutMs: GRAPH_DOWNLOAD_TIMEOUT_MS },
  );
  try {
    return await res.text();
  } catch (err) {
    throw asTransient(err);
  }
}

/**
 * Stream a recording to disk. Recordings run to hundreds of MB, so the body is
 * never buffered in memory. Graph 302s recording content to a pre-signed
 * SharePoint/blob URL; redirects are followed by hand with `redirect: 'manual'`
 * so graphFetch can drop the bearer the moment we leave the Graph origin (it
 * only ever sends one to that origin), and every hop is bounded by the download
 * timeout, which keeps running while the body streams.
 */
export async function downloadRecording(
  userId: string,
  graphMeetingId: string,
  recordingId: string,
  destPath: string,
): Promise<{ bytes: number }> {
  let url = `${graphOrigin()}/me/onlineMeetings/${encodeId(graphMeetingId)}/recordings/${encodeId(recordingId)}/content`;
  const hop = (target: string) =>
    graphFetch(userId, target, { redirect: 'manual' }, { timeoutMs: GRAPH_DOWNLOAD_TIMEOUT_MS });

  let res = await hop(url);
  for (let n = 0; res.status >= 300 && res.status < 400 && n < 5; n++) {
    const location = res.headers.get('location');
    if (!location) throw redirectError(res.status);
    url = new URL(location, url).href;
    res = await hop(url);
  }

  if (res.status >= 300) throw redirectError(res.status);
  if (!res.body) throw new GraphError('http', 'Optagelsen fra Microsoft Teams var tom', { status: res.status });

  let bytes = 0;
  const source = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
  source.on('data', (chunk: Buffer | string) => {
    bytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
  });
  try {
    await streamPipeline(source, createWriteStream(destPath));
  } catch (err) {
    throw asTransient(err);
  }
  return { bytes };
}

/** A redirect that names no place to go, or that never ends. */
function redirectError(status: number): GraphError {
  return new GraphError('http', `Microsoft Graph svarede ${status} på optagelsen`, { status });
}
