import { useEffect, useState } from "react";

export const useAudioLevels = (isRecording: boolean): number => {
  const [audioLevel, setAudioLevel] = useState(0);

  useEffect(() => {
    if (!isRecording) return;

    const setupAudio = async (): Promise<() => void> => {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const audioContext = new AudioContext();
      const analyser = audioContext.createAnalyser();
      const source = audioContext.createMediaStreamSource(stream);

      analyser.smoothingTimeConstant = 0.8;
      analyser.fftSize = 1024;
      source.connect(analyser);

      const dataArray = new Uint8Array(analyser.frequencyBinCount);

      const updateLevel = (): void => {
        analyser.getByteFrequencyData(dataArray);

        const average =
          dataArray.reduce((acc, value) => acc + value, 0) / dataArray.length;

        setAudioLevel(average);
        requestAnimationFrame(updateLevel);
      };

      updateLevel();

      return (): void => {
        source.disconnect();
        analyser.disconnect();
        audioContext.close();
      };
    };

    const cleanupPromise = setupAudio();

    return () => {
      cleanupPromise.then((cleanup) => cleanup()).catch(console.error);
    };
  }, [isRecording]);

  return audioLevel;
};
