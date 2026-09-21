import type { TranscriptSegment } from '@/types';

// Pure helpers that shape a transcript for an LLM prompt. STT emits short utterances, so
// a person speaking for a minute becomes many segments; repeating the speaker label and
// timestamp on each wastes a large share of the prompt. Turns collapse those.

export interface Turn {
  speaker: string;
  start: number; // seconds from the start of the recording
  text: string;
}

export interface TurnPart {
  text: string;  // rendered turns, at most the requested budget
  start: number; // start (seconds) of the first turn in this part
}

export function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// Collapse consecutive segments from the same speaker into one turn (start of the first).
export function mergeSpeakerTurns(segments: TranscriptSegment[]): Turn[] {
  const turns: Turn[] = [];
  for (const s of segments) {
    const last = turns[turns.length - 1];
    if (last && last.speaker === s.speaker) {
      last.text = `${last.text} ${s.text}`;
    } else {
      turns.push({ speaker: s.speaker, start: s.start, text: s.text });
    }
  }
  return turns;
}

function renderTurn(turn: Turn): string {
  return `[${turn.speaker}] (${formatTime(turn.start)}): ${turn.text}`;
}

export function renderTurns(turns: Turn[]): string {
  return turns.map(renderTurn).join('\n');
}

// Split one turn into pieces whose rendered line fits in `budgetChars`: at the last
// whitespace before the limit, or hard at the limit when there is none.
function splitLongTurn(turn: Turn, budgetChars: number): Turn[] {
  const room = Math.max(1, budgetChars - renderTurn({ ...turn, text: '' }).length);
  if (turn.text.length <= room) return [turn];

  const pieces: Turn[] = [];
  let rest = turn.text;
  while (rest.length > room) {
    let cut = rest.lastIndexOf(' ', room);
    if (cut <= 0) cut = room;
    pieces.push({ ...turn, text: rest.slice(0, cut) });
    rest = rest.slice(cut).trimStart();
  }
  if (rest) pieces.push({ ...turn, text: rest });
  return pieces;
}

// Pack consecutive turns into parts that each render to at most `budgetChars`, splitting
// at turn boundaries. Every character of every turn lands in exactly one part, in order
// (only the whitespace at an in-turn split point is dropped).
export function splitTurns(turns: Turn[], budgetChars: number): TurnPart[] {
  const parts: TurnPart[] = [];
  let lines: string[] = [];
  let size = 0;
  let partStart = 0;

  const flush = () => {
    if (lines.length > 0) {
      parts.push({ text: lines.join('\n'), start: partStart });
      lines = [];
      size = 0;
    }
  };

  for (const turn of turns) {
    for (const piece of splitLongTurn(turn, budgetChars)) {
      const line = renderTurn(piece);
      if (lines.length > 0 && size + 1 + line.length > budgetChars) flush();
      if (lines.length === 0) partStart = piece.start;
      size += (lines.length > 0 ? 1 : 0) + line.length;
      lines.push(line);
    }
  }
  flush();
  return parts;
}
