import { useMutation } from "@tanstack/react-query";
import { LucideSave, LucideTrash } from "lucide-react";

import { createHistoryEntry } from "@/lib/api/history-entry";
import {
  summarizeTranscription,
  transcribeAudio,
} from "@/lib/api/transcription";
import { useSession } from "@/lib/auth-client";
import {
  HISTORY_ENTRY_KIND,
  type PromptCategory,
  STEP_ID,
} from "@/lib/constants";
import type { HistoryEntryDTO, Transcript } from "@/lib/schemas/history";
import type { Prompt } from "@/lib/schemas/prompt";
import { Button } from "@/lib/ui/core/shadcn/button";
import { Checkbox } from "@/lib/ui/core/shadcn/checkbox";
import { Label } from "@/lib/ui/core/shadcn/label";
import { Spinner } from "@/lib/ui/core/shadcn/spinner";
import { Stepper, useStepper } from "@/lib/ui/custom/wizard/stepper";

import { Activity } from "react";

export const WizardControls = () => {
  const {
    isFirst,
    prev,
    isLast,
    reset,
    next,
    metadata,
    current,
    setMetadata,
    resetMetadata,
  } = useStepper();
  const isCompleted = metadata[current.id]?.["isCompleted"] as boolean;
  const currentFile = metadata[STEP_ID.UploadSpeechStep]?.["file"];
  const isFirstStep = current.id === STEP_ID.UploadSpeechStep;
  const isSelectPromptStep = current.id === STEP_ID.SelectPromptStep;

  const { data: session } = useSession();
  const user = session?.user ?? null;

  const { mutate: transcribe, status: transcribeStatus } = useMutation({
    mutationFn: ({ file }: { file: File }) => transcribeAudio({ file }),
    onSuccess: (result) => {
      setMetadata(STEP_ID.TranscriptionStep, {
        transcription: result.text,
        editedTranscription: "",
        isCompleted: false,
      });
      next();
    },
  });

  const { mutate: summarize, status: summarizeStatus } = useMutation({
    mutationFn: ({
      transcription,
      prompt,
      category,
    }: {
      transcription: string;
      prompt: string;
      category: PromptCategory;
    }) => summarizeTranscription({ transcription, prompt, category }),
    onSuccess: ({ summary }) => {
      setMetadata(STEP_ID.EditAndConfirmStep, {
        summary: summary,
        isCompleted: false,
      });
      next();
    },
  });

  const handleNextClick = () => {
    if (isFirstStep && currentFile) {
      transcribe({ file: currentFile });
    } else if (isSelectPromptStep) {
      const selectedPrompt: Prompt | undefined =
        metadata[STEP_ID.SelectPromptStep]?.["prompt"];
      const transcription =
        metadata[STEP_ID.TranscriptionStep]?.["editedTranscription"] ||
        metadata[STEP_ID.TranscriptionStep]?.["transcription"];

      if (selectedPrompt && transcription) {
        summarize({
          transcription,
          prompt: selectedPrompt.text,
          category: selectedPrompt.category,
        });
      }
    } else {
      next();
    }
  };

  const onResetClick = () => {
    reset();
    resetMetadata(true);
  };

  const onSaveClick = async () => {
    try {
      const transcript: string =
        metadata[STEP_ID.EditAndConfirmStep]?.["editedSummary"];

      const prompt: Prompt = metadata[STEP_ID.SelectPromptStep]?.["prompt"];

      const transcriptAsset: Transcript = {
        kind: HISTORY_ENTRY_KIND.TRANSCRIPT,
        text: transcript,
      };

      const title: string = metadata[STEP_ID.EditAndConfirmStep]?.["title"];

      if (!user?.id || !title || !transcript) {
        new Error("Missing required data for history entry.");
        return;
      }

      // Transform prompt into PromptAsset format
      const promptAsset = {
        kind: HISTORY_ENTRY_KIND.PROMPT,
        promptId: prompt.id,
        text: prompt.text,
      };

      const historyEntry: HistoryEntryDTO = {
        userId: user.id,
        title: title,
        assets: [promptAsset, transcriptAsset],
      };

      await createHistoryEntry(historyEntry);

      onResetClick();
    } catch (error) {
      console.error("Error saving history entry:", error);
    }
  };

  return (
    <Stepper.Controls className="flex justify-between items-center mt-6">
      <div className="min-w-[120px]">
        <Activity mode={!isFirst ? "visible" : "hidden"}>
          <Button onClick={prev}>Tilbage</Button>
        </Activity>
      </div>

      <div className="flex items-center gap-4">
        <Activity mode={isFirstStep ? "visible" : "hidden"}>
          <div className="flex items-center gap-2">
            <Checkbox
              disabled={!!currentFile}
              id="gdpr-filter"
              className="h-4 w-4"
              defaultChecked
            />
            <Label
              htmlFor="gdpr-filter"
              className="text-muted-foreground font-normal text-sm"
            >
              Slet personoplysninger i transskriptionen (GDPR-filter)
            </Label>
          </div>
        </Activity>
      </div>

      <div className="min-w-[120px] text-right flex gap-2 justify-end">
        <Activity mode={currentFile && isFirstStep ? "visible" : "hidden"}>
          <Button
            variant="destructive"
            onClick={() =>
              setMetadata(STEP_ID.UploadSpeechStep, {
                file: null,
                isCompleted: false,
              })
            }
          >
            <LucideTrash />
            Fjern valgt fil
          </Button>
        </Activity>

        <Activity mode="visible">
          {!isLast ? (
            <Button
              disabled={
                (!isLast && !isCompleted) ||
                transcribeStatus === "pending" ||
                summarizeStatus === "pending"
              }
              onClick={handleNextClick}
            >
              {transcribeStatus === "pending" ? (
                <>
                  <Spinner className="mr-2" /> Transskriberer...
                </>
              ) : summarizeStatus === "pending" ? (
                <>
                  <Spinner className="mr-2" /> Genererer referat...
                </>
              ) : (
                "Næste"
              )}
            </Button>
          ) : (
            <Button
              className={"bg-green-600 hover:bg-green-700"}
              onClick={onSaveClick}
            >
              <LucideSave /> Gem og nulstil
            </Button>
          )}
        </Activity>
      </div>
    </Stepper.Controls>
  );
};
