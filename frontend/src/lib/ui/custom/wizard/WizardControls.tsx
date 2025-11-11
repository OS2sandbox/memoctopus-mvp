import { LucideTrash } from "lucide-react";

import { createHistoryEntry } from "@/lib/api/history-entry";
import { useSession } from "@/lib/auth-client";
import { STEP_ID } from "@/lib/constants";
import { Button } from "@/lib/ui/core/shadcn/button";
import { ConfirmDialog } from "@/lib/ui/custom/dialog/ConfirmDialog";
import { Stepper, useStepper } from "@/lib/ui/custom/wizard/stepper";
import type { HistoryEntryDTO, Transcript } from "@/shared/schemas/history";
import type { Prompt } from "@/shared/schemas/prompt";

import { Activity, useState } from "react";

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

  const [open, setOpen] = useState(false);

  const { data: session } = useSession();
  const user = session?.user ?? null;

  const onResetClick = () => {
    reset();
    resetMetadata(true);
  };

  const onSaveClick = async () => {
    const transcript: string =
      metadata[STEP_ID.EditAndConfirmStep]?.["editedSummary"];

    const prompt: Prompt = metadata[STEP_ID.SelectPromptStep]?.["prompt"];

    const historyEntryTranscript: Transcript = {
      kind: "text",
      text: transcript,
    };

    const title: string = metadata[STEP_ID.EditAndConfirmStep]?.["title"];

    const historyEntry: HistoryEntryDTO = {
      userId: user?.id,
      title: title,
      assets: [prompt, historyEntryTranscript],
    };

    // TODO: remove log
    console.log("Creating history entry with data:", historyEntry);

    if (!user?.id || !title || !transcript) {
      console.error("Missing required data for history entry.");
      return;
    }

    await createHistoryEntry(historyEntry);

    onResetClick();
  };

  return (
    <Stepper.Controls className="flex justify-between items-center mt-6">
      <div className="min-w-[120px]">
        <Activity mode={!isFirst ? "visible" : "hidden"}>
          <Button onClick={prev}>Tilbage</Button>
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

        <Activity
          mode={
            current.id === STEP_ID.EditAndConfirmStep && !isCompleted
              ? "hidden"
              : "visible"
          }
        >
          {!isLast ? (
            <Button
              disabled={!isLast && !isCompleted}
              onClick={!isLast ? next : onSaveClick}
            >
              {isLast ? "Gem" : "Næste"}
            </Button>
          ) : (
            <ConfirmDialog
              open={open}
              onOpenChange={setOpen}
              onConfirm={onSaveClick}
              trigger={<Button>Gem og nulstil</Button>}
            >
              <p>Er du sikker på, at du vil gemme og nulstille?</p>
              <p>
                Idet du godkender, vil prompt og opsummering gemmes I historik.
              </p>
            </ConfirmDialog>
          )}
        </Activity>
      </div>
    </Stepper.Controls>
  );
};
