import { LucideTrash } from "lucide-react";

import { createHistoryEntry } from "@/lib/api/history-entry";
import { useSession } from "@/lib/auth-client";
import { STEP_ID } from "@/lib/constants";
import { Button } from "@/lib/ui/core/shadcn/button";
import { Stepper, useStepper } from "@/lib/ui/custom/wizard/stepper";
import type {
  FileAudio,
  HistoryEntryDTO,
  Transcript,
} from "@/shared/schemas/history";

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

  const { data: session } = useSession();
  const user = session?.user ?? null;

  const onSaveClick = async () => {
    const file: File = metadata[STEP_ID.UploadSpeechStep]?.["file"];
    const transcript: string =
      metadata[STEP_ID.EditAndConfirmStep]?.["editedSummary"];

    const historyEntryFile: FileAudio = {
      storage: "file",
      kind: "audio",
      file: {
        name: file.name,
        size: file.size,
        type: file.type,
      },
    };

    const historyEntryTranscript: Transcript = {
      kind: "text",
      text: transcript,
    };

    const title: string = metadata[STEP_ID.ShareStep]?.["title"];

    console.log("Creating history entry with data:", {
      userId: user?.id,
      title: title,
      assets: [historyEntryFile, historyEntryTranscript],
    });

    if (!user?.id || !title || !file || !transcript) {
      console.error("Missing required data for history entry.");
      return;
    }

    const historyEntry: HistoryEntryDTO = {
      userId: user?.id,
      title: title,
      assets: [historyEntryFile, historyEntryTranscript],
    };

    await createHistoryEntry(historyEntry);

    reset();
    resetMetadata(true);
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
          <Button
            disabled={!isLast && !isCompleted}
            onClick={!isLast ? next : onSaveClick}
          >
            {isLast ? "Gem" : "Næste"}
          </Button>
        </Activity>
      </div>
    </Stepper.Controls>
  );
};
