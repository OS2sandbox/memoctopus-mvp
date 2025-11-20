import { API_BASE_URL, type PROMPT_CATEGORY } from "@/lib/constants";

export interface TranscribeAudioProps {
  file: File;
}

export const transcribeAudio = async ({ file }: TranscribeAudioProps) => {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("model", "whisper-1");

  // I ONLY use absolute URL here because MSW is running and intercepting relative URLs; to be changed
  const res = await fetch(`${API_BASE_URL}/v1/audio/transcriptions`, {
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
  category: PROMPT_CATEGORY;
}

// TODO: RTFM
export const summarizeTranscription = async ({
  transcription,
  prompt,
  category,
}: SummarizeTranscriptionProps) => {
  const body = {
    model: "gpt-5-nano",
    messages: [
      {
        role: "system",
        content: `You are a transcription summarization assistant specializing in ${category}: ${prompt}`,
      },
      {
        role: "user",
        content: transcription,
      },
    ],
  };
  const res = await fetch(`${API_BASE_URL}/v1/chat/completions`, {
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
  category: PROMPT_CATEGORY;
}

export const transcribeAndSummarize = async ({
  file,
  prompt,
  category,
}: TranscribeAndSummarizeProps) => {
  const transcription = await transcribeAudio({ file });

  const { summary } = await summarizeTranscription({
    transcription: transcription.text,
    prompt,
    category: category,
  });

  return summary;
};
