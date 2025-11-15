import { useMutation, useQuery } from "@tanstack/react-query";

import { getPrompts } from "@/lib/api/prompts";
import {
  type SummarizeTranscriptionProps,
  summarizeTranscription,
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

  // Get the edited or original transcription from the previous step
  const transcriptionMetadata = metadata[STEP_ID.TranscriptionStep] ?? {};
  const transcription =
    (transcriptionMetadata["editedTranscription"] as string) ||
    (transcriptionMetadata["transcription"] as string);

  const { mutate: summarize, status: summaryStatus } = useMutation({
    mutationFn: ({
      transcription,
      prompt,
      category,
    }: SummarizeTranscriptionProps) =>
      summarizeTranscription({
        transcription: transcription,
        prompt: prompt,
        category: category,
      }),
    onSuccess: (result) => {
      // Keep SelectPromptStep metadata as-is (prompt and isCompleted are already set)
      setMetadata(STEP_ID.EditAndConfirmStep, {
        summary: result.summary,
        isCompleted: false,
        isLoading: false,
      });
    },
    onError: () => {
      setMetadata(STEP_ID.EditAndConfirmStep, {
        summary: "",
        isCompleted: false,
        isLoading: false,
        error: true,
      });
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
      isCompleted: true,
    });

    // Navigate to next step immediately and show loading state
    setMetadata(STEP_ID.EditAndConfirmStep, {
      summary: "",
      isCompleted: false,
      isLoading: true,
      error: false,
    });
    next();

    // Then start summarization
    summarize({
      transcription: transcription,
      prompt: entry.text,
      category: entry.category,
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
