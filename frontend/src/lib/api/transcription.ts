export interface TranscribeAudioProps {
  file: File;
}

export const transcribeAudio = async ({ file }: TranscribeAudioProps) => {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("model", "whisper-1");

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

export interface SummarizeTranscriptionProps {
  transcription: string;
  prompt: string;
}

// TODO: RTFM
export const summarizeTranscription = async ({
  transcription,
  prompt,
}: SummarizeTranscriptionProps) => {
  const body = {
    model: "gpt-5-nano",
    messages: [
      {
        role: "system",
        content: prompt,
      },
      {
        role: "user",
        content: transcription,
      },
    ],
  };

  const res = await fetch("http://localhost:8000/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error("Failed to summarize transcription");
  }

  const data = await res.json();

  const summary: Promise<string> =
    data?.choices?.[0]?.message?.content ?? "Ingen opsummering tilgængelig.";

  return { summary };
};

export interface TranscribeAndSummarizeProps {
  file: File;
  prompt: string;
}

export const transcribeAndSummarize = async ({
  file,
  prompt,
}: TranscribeAndSummarizeProps) => {
  const transcription = await transcribeAudio({ file });

  const { summary } = await summarizeTranscription({
    transcription: transcription.text,
    prompt,
  });

  return summary;
};
