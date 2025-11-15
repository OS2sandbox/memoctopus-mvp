import { RECORDER_STATUS } from "@/lib/constants";
import { useAudioLevels } from "@/lib/hooks/use-audio-levels";
import { useRecorderState } from "@/lib/hooks/use-recorder-state";
import { useWarnBeforeUnload } from "@/lib/hooks/use-warn-before-unload";

import { useEffect, useRef } from "react";

interface UseRecorderProps {
  autoSave?: (file: File) => void;
  onError?: (error: Error) => void;
}

export const useRecorder = ({ autoSave, onError }: UseRecorderProps) => {
  const { state, actions } = useRecorderState();

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<number | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const timeRef = useRef<number>(0);

  useWarnBeforeUnload(state.status === RECORDER_STATUS.Recording);

  const stopActiveStream = () => {
    const stream = streamRef.current;
    if (stream) {
      for (const track of stream.getTracks()) track.stop();
      streamRef.current = null;
    }
  };

  const startTimer = () => {
    timeRef.current = 0;
    actions.setTime(0);
    timerRef.current = window.setInterval(() => {
      timeRef.current += 1;
      actions.setTime(timeRef.current);
    }, 1000);
  };

  const stopTimer = () => {
    if (timerRef.current) window.clearInterval(timerRef.current);
  };

  const start = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "";

      const recorder = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = recorder;
      chunksRef.current = [];

      recorder.ondataavailable = (event) =>
        event.data.size > 0 && chunksRef.current.push(event.data);

      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: mimeType });
        const file = new File([blob], `rec_${Date.now()}.webm`, {
          type: mimeType,
        });
        const url = URL.createObjectURL(blob);

        actions.stopRecording({ blob, file, url });
        stopTimer();

        // TODO: Consider if we need autosave or just manual save options
        autoSave?.(file);
      };

      recorder.start();
      actions.startRecording();
      startTimer();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Microphone access denied.";

      actions.setError(message);
      onError?.(error instanceof Error ? error : new Error(message));
    }
  };

  const pause = () => {
    if (mediaRecorderRef.current?.state === "recording") {
      mediaRecorderRef.current.pause();
      stopTimer();
      actions.pauseRecording();
    }
  };

  const resume = () => {
    if (mediaRecorderRef.current?.state === "paused") {
      mediaRecorderRef.current.resume();
      startTimer();
      actions.resumeRecording();
    }
  };

  const stop = () => {
    const rec = mediaRecorderRef.current;

    if (rec && state.status !== RECORDER_STATUS.Idle) {
      rec.stop();
      stopActiveStream();
      stopTimer();
    }
  };

  const audioLevel = useAudioLevels(streamRef.current);

  const reset = () => {
    stopTimer();
    stopActiveStream();

    if (state.url) URL.revokeObjectURL(state.url);
    actions.resetRecorder();
  };

  useEffect(() => {
    return () => {
      stopTimer();
      stopActiveStream();
    };
  }, []);

  return {
    audioLevel,
    status: state.status,
    isRecording: state.status === RECORDER_STATUS.Recording,
    blob: state.blob,
    file: state.file,
    url: state.url,
    time: state.time,
    error: state.error,

    start,
    pause,
    resume,
    stop,
    reset,
  };
};
