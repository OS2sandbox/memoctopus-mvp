import type { TranscriptSegment } from '@/types';
import type { SpeakerTurn } from '@/lib/ai/diarization';
import { DEFAULT_SPEAKER_LABEL } from '@/lib/audio/speaker-labels';
import { fillSpeakerNames } from './name-speakers';

// ─── WebVTT parsing for Microsoft Teams transcripts ───────────────────────────
// Teams exposes a meeting transcript through Graph as WebVTT where every cue
// carries the speaker's *display name* in a voice span:
//
//   WEBVTT
//
//   b1c1c3d2-.../1-0
//   00:00:03.120 --> 00:00:07.480
//   <v Mette Hansen>Godmorgen, skal vi tage r&#39;undt om bordet?</v>
//
// That name is the whole point of the Graph integration (see the plan's
// "Speaker names in Gennemgang"): hviske gives us the Danish text, Microsoft
// gives us who said it. This module is pure — no I/O, no env — so the parsing
// rules can be pinned down by tests.

export interface VttCue {
  speaker: string | null; // display name from <v …>, verbatim; null when the cue has no voice span
  start: number; // seconds
  end: number; // seconds
  text: string; // tag-free, entity-decoded, multi-line payloads joined with a space
}

// Cues from the same speaker separated by less than this are one turn.
const TURN_MERGE_GAP_SECONDS = 0.5;

// HH:MM:SS.mmm, MM:SS.mmm, and (tolerated) a comma decimal separator from
// SRT-flavoured exporters. Returns NaN for anything unparseable so the caller
// can drop the cue rather than emit a bogus timestamp.
function parseTimestamp(raw: string): number {
  const match = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/.exec(raw.trim());
  if (!match) return NaN;
  const [, hours, minutes, seconds, fraction] = match;
  return (
    Number(hours ?? 0) * 3600 +
    Number(minutes) * 60 +
    Number(seconds) +
    Number(`0.${fraction ?? 0}`)
  );
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

// Decodes the entity subset WebVTT allows plus numeric references. Applied
// *after* tags are stripped, so an escaped `&lt;v&gt;` in the text is never
// mistaken for a real voice span.
function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#')) {
      const code = body[1] === 'x' || body[1] === 'X'
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

function stripTags(text: string): string {
  return text.replace(/<\/?[^>]*>/g, '');
}

// Parses a WebVTT document into cues. Tolerates a UTF-8 BOM, CRLF line endings,
// NOTE/STYLE/REGION blocks, optional cue identifiers and cue settings after the
// end timestamp. Malformed blocks are skipped rather than throwing: a partly
// broken transcript is still worth most of its speaker timeline.
export function parseVtt(vtt: string): VttCue[] {
  if (!vtt) return [];
  const normalised = vtt.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const blocks = normalised.split(/\n{2,}/);
  const cues: VttCue[] = [];

  for (const block of blocks) {
    const lines = block.split('\n').filter((line) => line.trim() !== '');
    if (lines.length === 0) continue;

    const head = lines[0].trim();
    if (/^WEBVTT/.test(head)) continue;
    if (/^(NOTE|STYLE|REGION)\b/.test(head)) continue;

    const arrowIndex = lines.findIndex((line) => line.includes('-->'));
    if (arrowIndex === -1) continue; // no timing line — not a cue

    const timing = /^\s*(\S+)\s*-->\s*(\S+)/.exec(lines[arrowIndex]);
    if (!timing) continue;
    const start = parseTimestamp(timing[1]);
    const end = parseTimestamp(timing[2]);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;

    const payload = lines.slice(arrowIndex + 1);
    // Teams puts the voice span on the first payload line; a long utterance is
    // wrapped across lines with the closing </v> on the last one.
    const voice = /<v(?:\.[^\s>]*)*\s+([^>]*)>/.exec(payload.join('\n'));
    const speaker = voice ? decodeEntities(voice[1]).trim() || null : null;

    const text = decodeEntities(stripTags(payload.join('\n')))
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .join(' ')
      .trim();

    cues.push({ speaker, start, end, text });
  }

  return cues;
}

// Speaker timeline in the shape `assignSpeakers()` consumes — but with human
// names instead of pyannote's SPEAKER_00. Cues without a voice span carry no
// speaker information and are dropped; consecutive cues from the same person
// separated by a breath (< 0.5 s) become one turn, so the merge onto hviske
// segments isn't fragmented by Teams' per-sentence cue splitting.
export function turnsFromVtt(cues: VttCue[]): SpeakerTurn[] {
  const turns: SpeakerTurn[] = [];
  for (const cue of cues) {
    if (!cue.speaker) continue;
    const last = turns[turns.length - 1];
    if (last && last.speaker === cue.speaker && cue.start - last.end < TURN_MERGE_GAP_SECONDS) {
      last.end = Math.max(last.end, cue.end);
      continue;
    }
    turns.push({ speaker: cue.speaker, start: cue.start, end: cue.end });
  }
  return turns;
}

// Transcript-only mode: Teams' own text becomes the transcript directly, with no
// audio, no hviske and no diarization pass. Empty cues are dropped; a cue with
// no voice span falls back to the app's default label so the review screen still
// has something to rename.
export function segmentsFromVtt(cues: VttCue[]): TranscriptSegment[] {
  // A cue with no voice span gets the placeholder here and then the name of
  // whoever was speaking around it — see fillSpeakerNames. A Teams meeting
  // should never reach the review screen with an unattributed "Taler 1".
  return fillSpeakerNames(
    cues
      .filter((cue) => cue.text !== '')
      .map((cue) => ({
        speaker: cue.speaker ?? DEFAULT_SPEAKER_LABEL,
        start: cue.start,
        end: cue.end,
        text: cue.text,
      })),
  );
}

// Distinct display names in first-appearance order — the pre-filled participant
// list for Gennemgang.
export function speakersFromVtt(cues: VttCue[]): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const cue of cues) {
    if (!cue.speaker || seen.has(cue.speaker)) continue;
    seen.add(cue.speaker);
    names.push(cue.speaker);
  }
  return names;
}
