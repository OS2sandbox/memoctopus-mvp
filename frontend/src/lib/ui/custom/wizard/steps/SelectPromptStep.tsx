import { useMutation, useQuery } from "@tanstack/react-query";

import { getPrompts } from "@/lib/api/prompts";
import {
  type TranscribeAudioProps,
  transcribeAudio,
} from "@/lib/api/transcription";
import { FILTER_MODE, STEP_ID } from "@/lib/constants";
import type { Prompt } from "@/lib/schemas/prompt";
import { Spinner } from "@/lib/ui/core/shadcn/spinner";
import { PromptTable } from "@/lib/ui/custom/prompt-library/table/PromptTable";
import { useStepper } from "@/lib/ui/custom/wizard/stepper";
import { WizardPanel } from "@/lib/ui/custom/wizard/WizardPanel";

import { useEffect } from "react";

export const SelectPromptStep = () => {
  const { metadata, setMetadata } = useStepper();
  const selectPromptMetadata = metadata[STEP_ID.SelectPromptStep] ?? {};
  const selectedPrompt: Prompt | undefined = selectPromptMetadata["prompt"];

  const { mutate: transcribe, data: transcription } = useMutation({
    mutationFn: ({ file, prompt }: TranscribeAudioProps) =>
      transcribeAudio({ file: file, prompt: prompt }),
  });

  const { data, status } = useQuery({
    queryKey: ["prompts"],
    queryFn: getPrompts,
  });

  console.log("Transcription data:", transcription);

  const handleOnRowClick = (entry: Prompt) => {
    setMetadata(STEP_ID.SelectPromptStep, {
      ...selectPromptMetadata,
      prompt: entry,
    });

    if (selectedPrompt) {
      transcribe({
        file: metadata[STEP_ID.UploadSpeechStep]?.["file"],
        prompt: selectedPrompt?.text,
      });
    }
  };

  useEffect(() => {
    if (!transcription) return;
    setMetadata(STEP_ID.SelectPromptStep, {
      ...selectPromptMetadata,
      isCompleted: true,
    });

    setMetadata(STEP_ID.EditAndConfirmStep, {
      ...selectPromptMetadata,
      transcript: transcription.text,
    });
  }, [transcription]);

  // TODO: Repeated code. This should definitely be a hook
  const renderContent = () => {
    switch (status) {
      case "error":
        return <p>Der opstod en fejl ved hentning af prompts.</p>;
      case "pending":
        return <Spinner />;
      case "success":
        return (
          <PromptTable
            data={data}
            HideAddButton={true}
            onRowClick={handleOnRowClick}
            tableMode={[FILTER_MODE.Favorites, FILTER_MODE.Mine]}
          />
        );
      default:
        return null;
    }
  };

  return <WizardPanel>{renderContent()}</WizardPanel>;
};
