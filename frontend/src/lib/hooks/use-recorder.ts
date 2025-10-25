import { useAudioLevels } from "@/lib/hooks/use-audio-levels";
import { useWarnBeforeUnload } from "@/lib/hooks/use-warn-before-unload";

import { useEffect, useRef, useState } from "react";

export enum RecorderStatus {
  Idle = "idle",
  Recording = "recording",
  Stopped = "stopped",
  Paused = "paused",
  Error = "error",
}

interface UseRecorderProps {
  autoSave?: (file: File) => void;
  onError?: (error: Error) => void;
}

export const useRecorder = ({ autoSave, onError }: UseRecorderProps) => {
  const [status, setStatus] = useState<RecorderStatus>(RecorderStatus.Idle);
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [blob, setBlob] = useState<Blob | null>(null);
  const [time, setTime] = useState<number>(0);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<number | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);

  useWarnBeforeUnload(status === RecorderStatus.Recording);

  const startTimer = () => {
    setTime(0);
    timerRef.current = window.setInterval(() => {
      setTime((prevTime) => prevTime + 1);
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

        setBlob(blob);
        setFile(file);
        setUrl(url);

        stream.getTracks().forEach((track) => track.stop());

        setStatus(RecorderStatus.Stopped);
        stopTimer();

        // TODO: Consider if we need autosave or just manual save options
        autoSave?.(file);
      };

      recorder.start();
      setStatus(RecorderStatus.Recording);
      startTimer();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Microphone access denied.";

      setError(message);
      setStatus(RecorderStatus.Error);
      onError?.(error instanceof Error ? error : new Error(message));
    }
  };

  const pause = () => {
    if (mediaRecorderRef.current?.state === "recording") {
      mediaRecorderRef.current.pause();
      stopTimer();
      setStatus(RecorderStatus.Paused);
    }
  };

  const resume = () => {
    if (mediaRecorderRef.current?.state === "paused") {
      mediaRecorderRef.current.resume();
      startTimer();
      setStatus(RecorderStatus.Recording);
    }
  };

  const stop = () => {
    if (mediaRecorderRef.current && status !== RecorderStatus.Idle) {
      mediaRecorderRef.current.stop();
      stopTimer();
    }
  };

  const audioLevel = useAudioLevels(status === RecorderStatus.Recording);

  const reset = () => {
    setStatus(RecorderStatus.Idle);
    setError(null);
    setUrl(null);
    setFile(null);
    setBlob(null);
    setTime(0);
  };

  useEffect(() => {
    return () => stopTimer();
  }, []);

  return {
    audioLevel,
    status,
    isRecording: status === RecorderStatus.Recording,
    blob,
    file,
    url,
    time,
    error,

    start,
    pause,
    resume,
    stop,
    reset,
  };
};
