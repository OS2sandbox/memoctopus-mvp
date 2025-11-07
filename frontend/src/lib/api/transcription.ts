export interface TranscribeAudioProps {
  file: File;
  prompt: string;
}

export const transcribeAudio = async ({
  file,
  prompt,
}: TranscribeAudioProps) => {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("model", "whisper-1");
  formData.append("prompt", prompt);

  // I ONLY use absolute URL here because MSW is running and intercepting relative URLs; to be changed
  const res = await fetch("http://localhost:8000/v1/audio/transcriptions", {
    method: "POST",
    body: formData,
  });

  if (!res.ok) {
    throw new Error("Failed to transcribe audio");
  }

  const result: Promise<{ text: string }> = res.json();

  return result;
};
