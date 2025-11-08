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

export const SelectPromptStep = () => {
  const { metadata, setMetadata } = useStepper();
  const selectPromptMetadata = metadata[STEP_ID.SelectPromptStep] ?? {};
  const selectedPrompt: Prompt | undefined = selectPromptMetadata["prompt"];

  const { mutate: transcribe } = useMutation({
    mutationFn: ({ file, prompt }: TranscribeAudioProps) =>
      transcribeAudio({ file: file, prompt: prompt }),
    onSuccess: (transcription) => {
      setMetadata(STEP_ID.SelectPromptStep, {
        ...selectPromptMetadata,
        isCompleted: selectedPrompt,
      });

      setMetadata(STEP_ID.EditAndConfirmStep, {
        ...selectPromptMetadata,
        transcript: transcription.text,
      });
    },
  });

  const { data, status } = useQuery({
    queryKey: ["prompts"],
    queryFn: getPrompts,
  });

  const handleOnRowClick = (entry: Prompt) => {
    setMetadata(STEP_ID.SelectPromptStep, {
      ...selectPromptMetadata,
      prompt: entry,
    });

    transcribe({
      file: metadata[STEP_ID.UploadSpeechStep]?.["file"],
      prompt: entry.text,
    });
  };

  // TODO: Repeated code. This should definitely be a hook
  const renderContent = () => {
    switch (status) {
      case "error":
        return <p>Der opstod en fejl ved hentning af prompts.</p>;
      case "pending": {
        return <Spinner />;
      }
      case "success": {
        return (
          <PromptTable
            data={data}
            hideAddButton={true}
            onRowClick={handleOnRowClick}
            tableMode={[FILTER_MODE.Favorites, FILTER_MODE.Mine]}
          />
        );
      }
      default:
        return null;
    }
  };

  return <WizardPanel>{renderContent()}</WizardPanel>;
};
