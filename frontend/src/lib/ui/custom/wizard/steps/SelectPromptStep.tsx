import { useMutation, useQuery } from "@tanstack/react-query";

import { getPrompts } from "@/lib/api/prompts";
import {
  type TranscribeAndSummarizeProps,
  transcribeAndSummarize,
} from "@/lib/api/transcription";
import { DATA_TABLE_SCOPE, STEP_ID } from "@/lib/constants";
import { Spinner } from "@/lib/ui/core/shadcn/spinner";
import { PromptTable } from "@/lib/ui/custom/prompt-library/table/PromptTable";
import { useStepper } from "@/lib/ui/custom/wizard/stepper";
import { WizardPanel } from "@/lib/ui/custom/wizard/WizardPanel";
import type { Prompt } from "@/shared/schemas/prompt";

export const SelectPromptStep = () => {
  const { metadata, setMetadata, next } = useStepper();
  const selectPromptMetadata = metadata[STEP_ID.SelectPromptStep] ?? {};
  const selectedPrompt: Prompt | undefined = selectPromptMetadata["prompt"];

  const { mutate: summarize, status: summaryStatus } = useMutation({
    mutationFn: ({ file, prompt }: TranscribeAndSummarizeProps) =>
      transcribeAndSummarize({ file: file, prompt: prompt }),
    onSuccess: (summary) => {
      setMetadata(STEP_ID.SelectPromptStep, {
        ...selectPromptMetadata,
        isCompleted: selectedPrompt,
      });
      setMetadata(STEP_ID.EditAndConfirmStep, {
        ...selectPromptMetadata,
        summary: summary,
        isCompleted: false,
      });

      next();
    },
  });

  const { data: prompts, status } = useQuery({
    queryKey: ["prompts"],
    queryFn: getPrompts,
  });

  const handleOnRowClick = (entry: Prompt) => {
    setMetadata(STEP_ID.SelectPromptStep, {
      ...selectPromptMetadata,
      prompt: entry,
    });

    summarize({
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
            data={prompts}
            hideAddButton={true}
            rowClickConfig={{
              onRowClick: handleOnRowClick,
              status: summaryStatus,
            }}
            tableMode={[DATA_TABLE_SCOPE.MyFavorites, DATA_TABLE_SCOPE.MyItems]}
          />
        );
      }
      default:
        return null;
    }
  };

  return <WizardPanel>{renderContent()}</WizardPanel>;
};
