import { describe, it, expect } from 'vitest';
import { cleanTranscribedText, degenerationStart } from './hallucinations';

// Every string quoted here came back from the production hviske server
// (syvai/hviske-v5.1) for a real Microsoft Teams cloud recording.

describe('cleanTranscribedText — subtitle credits', () => {
  it('drops the credit a Whisper model emits over near-silence', () => {
    expect(cleanTranscribedText('Danske tekster af Jesper Buhl Scandinavian Text Service 2018')).toBe('');
  });

  it('drops the short Danish sign-offs too', () => {
    expect(cleanTranscribedText('Tak skal I have.')).toBe('');
    expect(cleanTranscribedText('Tak for at se med.')).toBe('');
    expect(cleanTranscribedText('Undertekster af Nicolai Winther')).toBe('');
  });

  it('keeps a real sentence that merely resembles one', () => {
    expect(cleanTranscribedText('Tak skal I have for de tal, vi kigger på dem i morgen.')).toBe(
      'Tak skal I have for de tal, vi kigger på dem i morgen.',
    );
  });
});

describe('cleanTranscribedText — repetition loops', () => {
  // The whole point of the rewrite: the old guard answered a boolean and the
  // caller threw the batch away, so these opening words never reached the user.
  it('keeps the real prefix and cuts the loop off', () => {
    const text =
      'Jeg har arbejdet på at få en blik. ' + 'Det er det, jeg har været. '.repeat(20);
    const cleaned = cleanTranscribedText(text);
    expect(cleaned).toContain('Jeg har arbejdet på at få en blik.');
    expect(cleaned.match(/jeg har været/gi)?.length ?? 0).toBeLessThanOrEqual(1);
  });

  it('cuts a single word spinning out', () => {
    const cleaned = cleanTranscribedText('og så skal du bare give dem farve ' + 'så '.repeat(40));
    expect(cleaned).toContain('og så skal du bare give dem farve');
    expect(cleaned.length).toBeLessThan(80);
  });

  it('returns nothing when the window was only the loop', () => {
    expect(cleanTranscribedText('Det. '.repeat(30))).toBe('');
  });

  it('leaves ordinary speech alone', () => {
    const text = 'Vi skal have styr på budgettet, og så skal vi tale om personalesagen.';
    expect(cleanTranscribedText(text)).toBe(text);
  });

  it('tolerates a word repeated a couple of times, as people do', () => {
    const text = 'Hallo, hallo, pizza, pizza til frokost, pizza til frokost med kage.';
    expect(cleanTranscribedText(text)).toBe(text);
  });

  it('is empty for empty input', () => {
    expect(cleanTranscribedText('   ')).toBe('');
  });

  // The cut keeps the FIRST occurrence of the repeated word — it is usually real
  // speech and only the echo after it is not. So a word before the loop survives
  // together with one copy of the loop's word, not alone.
  it('keeps the words before a loop plus its first occurrence', () => {
    expect(cleanTranscribedText('Ja ' + 'nej '.repeat(20))).toBe('Ja nej');
  });

  // …which is why the under-two-words rule only fires when the window OPENS with
  // the loop, leaving a single word behind. (See also 'returns nothing when the
  // window was only the loop'.)
  it('drops a window that opens straight into a loop', () => {
    expect(cleanTranscribedText('nej '.repeat(20))).toBe('');
  });

  // The loop can follow a credit rather than speech, and the credit patterns are
  // prefix matches — so the surviving prefix has to be re-checked after the cut.
  it('drops a surviving prefix that is itself a credit', () => {
    expect(cleanTranscribedText('Undertekster af Nicolai Winther ' + 'nej '.repeat(20))).toBe('');
  });
});

describe('degenerationStart', () => {
  it('is the full length when nothing repeats', () => {
    const words = 'vi tager den på næste møde'.split(' ');
    expect(degenerationStart(words)).toBe(words.length);
  });

  it('points at the first echo of a repeated phrase', () => {
    const words = 'der er noget der er noget der er noget der er noget'.split(' ');
    expect(degenerationStart(words)).toBe(3);
  });
});
