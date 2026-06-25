import { describe, it, expect } from 'vitest';
import { pickRecordingMimeType, extensionForMimeType } from './recording-format';

describe('pickRecordingMimeType', () => {
  it('prefers webm/opus on desktop Chrome (everything supported)', () => {
    expect(pickRecordingMimeType(() => true)).toBe('audio/webm;codecs=opus');
  });

  it('falls back to mp4 on iOS Safari (only mp4 supported)', () => {
    const iosSupport = (t: string) => t.startsWith('audio/mp4');
    expect(pickRecordingMimeType(iosSupport)).toBe('audio/mp4');
  });

  it('falls back to plain webm when opus codec is unsupported', () => {
    const support = (t: string) => t === 'audio/webm';
    expect(pickRecordingMimeType(support)).toBe('audio/webm');
  });

  it("returns '' when nothing is supported so the browser picks a default", () => {
    expect(pickRecordingMimeType(() => false)).toBe('');
  });
});

describe('extensionForMimeType', () => {
  it('maps mp4/m4a to m4a', () => {
    expect(extensionForMimeType('audio/mp4')).toBe('m4a');
    expect(extensionForMimeType('audio/mp4;codecs=mp4a.40.2')).toBe('m4a');
  });

  it('maps ogg to ogg', () => {
    expect(extensionForMimeType('audio/ogg;codecs=opus')).toBe('ogg');
  });

  it('defaults to webm', () => {
    expect(extensionForMimeType('audio/webm;codecs=opus')).toBe('webm');
    expect(extensionForMimeType('')).toBe('webm');
  });
});
