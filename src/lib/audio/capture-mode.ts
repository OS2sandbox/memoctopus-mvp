// Microphone capture modes for in-browser recording.
//
// Browser mic processing (noise suppression + echo cancellation) is built for a
// single nearby speaker on a headset: it locks onto the dominant voice and gates
// other voices in the room as background noise, so a multi-speaker meeting loses
// every voice but the one closest to the microphone — before any downstream code
// can recover it. For room recordings the processing must be off, and AGC on so
// quiet/distant speakers are boosted above the VAD's speech threshold.
//
// 'headset' keeps the browser processing for the one case it is right for: a
// single speaker dictating, where suppression removes keyboard/room noise.
// Trade-off of 'room': audio played through the machine's speakers while
// recording is picked up (no echo cancellation).

export type CaptureMode = 'room' | 'headset';

export const CAPTURE_MODE_STORAGE_KEY = 'referat.capture-mode';

export const CAPTURE_MODE_LABELS: Record<CaptureMode, string> = {
  room: 'møderum',
  headset: 'headset',
};

export function micConstraints(mode: CaptureMode): MediaTrackConstraints {
  return mode === 'headset'
    ? { noiseSuppression: true, echoCancellation: true, autoGainControl: false }
    : { noiseSuppression: false, echoCancellation: false, autoGainControl: true };
}

// Default is 'room': the product records meetings, and losing a speaker is
// irreversible while picking up some room noise is handled downstream (Silero
// VAD speech threshold + hallucination trimming).
export function loadCaptureMode(): CaptureMode {
  try {
    const stored = window.localStorage.getItem(CAPTURE_MODE_STORAGE_KEY);
    return stored === 'headset' ? 'headset' : 'room';
  } catch {
    return 'room';
  }
}

export function saveCaptureMode(mode: CaptureMode): void {
  try {
    window.localStorage.setItem(CAPTURE_MODE_STORAGE_KEY, mode);
  } catch {
    // Private browsing / storage disabled: the choice simply doesn't persist.
  }
}
