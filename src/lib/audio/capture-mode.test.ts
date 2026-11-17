// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import {
  micConstraints,
  loadCaptureMode,
  saveCaptureMode,
  CAPTURE_MODE_STORAGE_KEY,
} from './capture-mode';

describe('micConstraints', () => {
  // Regression test for the room-recording bug: with noise suppression /
  // echo cancellation on, the browser gates all but the dominant speaker,
  // so a multi-speaker room recording loses every other voice.
  it('room mode turns browser voice-call processing off and AGC on', () => {
    expect(micConstraints('room')).toEqual({
      noiseSuppression: false,
      echoCancellation: false,
      autoGainControl: true,
    });
  });

  it('headset mode keeps the legacy single-speaker processing', () => {
    expect(micConstraints('headset')).toEqual({
      noiseSuppression: true,
      echoCancellation: true,
      autoGainControl: false,
    });
  });
});

describe('load/saveCaptureMode', () => {
  beforeEach(() => window.localStorage.clear());

  it('defaults to room when nothing is stored', () => {
    expect(loadCaptureMode()).toBe('room');
  });

  it('round-trips headset through localStorage', () => {
    saveCaptureMode('headset');
    expect(window.localStorage.getItem(CAPTURE_MODE_STORAGE_KEY)).toBe('headset');
    expect(loadCaptureMode()).toBe('headset');
  });

  it('falls back to room on an unknown stored value', () => {
    window.localStorage.setItem(CAPTURE_MODE_STORAGE_KEY, 'garbage');
    expect(loadCaptureMode()).toBe('room');
  });
});
